/**
 * Worker-side architecture tools: `consult_architect` asks the architect a
 * question and returns a binding Ruling. Mount this plugin in worker presets;
 * the architect preset mounts `./architect` instead.
 * @module @deepseek-ai/dsh-experimental-tool-architecture
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConsultResult, Ruling, RulingId } from '@deepseek-ai/dsh-experimental-architecture'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ToolExecutionToken } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-architecture'
/** Services required by the worker tools. */
export const inject = ['architecture', 'tools', 'systemPrompt']

/** Model-facing guidance for workers. */
export const WORKER_POLICY = [
  'This workspace keeps its architecture in committed documents. Before a change that adds or moves a responsibility between modules, changes a public interface or data format, or introduces a new dependency or pattern, call `consult_architect` with the concrete question and the paths involved.',
  'A Ruling\'s constraints are binding: follow them even when a local shortcut looks easier. Unresolved points are not constraints; decide them yourself or ask the user.',
  'When you have concrete evidence that a constraint is wrong for this change, call `appeal_ruling` with the Ruling id, your reason, and the evidence. The constraint stays binding until the user decides; continue work it does not affect, or stop and wait.',
  'Architecture documents are read-only for you. Do not edit them with file tools or shell commands.',
].join('\n\n')

const CITATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    anchor: { type: 'string', required: true },
    hash: { type: 'string', required: true },
  },
} as const

/** Worker tool that asks the architect; its visibility also gates the worker guidance. */
const CONSULT_ARCHITECT_TOOL = 'consult_architect'

/** Worker tool that appeals a Ruling. */
const APPEAL_RULING_TOOL = 'appeal_ruling'

/** Canonical `consult_architect` value. */
const CONSULT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true, enum: ['ruling', 'timeout', 'no-submission'] },
    rulingId: { type: 'string', required: true },
    summary: { type: 'string' },
    constraints: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          statement: { type: 'string', required: true },
          citations: { type: 'array', required: true, items: CITATION_SCHEMA },
        },
      },
    },
    unresolved: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          statement: { type: 'string', required: true },
          reason: { type: 'string' },
        },
      },
    },
    proposedEdits: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          section: { type: 'string', required: true },
          rationale: { type: 'string', required: true },
        },
      },
    },
  },
} as const

type ConsultValue = InferValue<typeof CONSULT_OUTPUT>

/**
 * Project a consultation result onto the canonical tool value.
 * @param result - the service's consultation result.
 * @returns the value the model and PTC code receive.
 */
export function consultValue(result: ConsultResult): ConsultValue {
  if (result.kind !== 'ruling') return { status: result.kind, rulingId: result.id, constraints: [], unresolved: [], proposedEdits: [] }
  const ruling: Ruling = result.ruling
  return {
    status: 'ruling',
    rulingId: ruling.id,
    summary: ruling.summary,
    constraints: ruling.constraints.map(constraint => ({
      statement: constraint.statement,
      citations: constraint.citations.map(citation => ({ path: citation.path, anchor: citation.anchor, hash: citation.hash })),
    })),
    unresolved: ruling.unresolved.map(point => ({
      statement: point.statement,
      ...point.reason === undefined ? {} : { reason: point.reason },
    })),
    // The proposed text is the user's to review; the worker learns which sections it would change and why.
    proposedEdits: ruling.proposedEdits.map(edit => ({ section: `${edit.path}#${edit.anchor}`, rationale: edit.rationale })),
  }
}

/**
 * Render a consultation value for the model.
 * @param value - the canonical value.
 * @returns the model-facing text.
 */
export function renderConsultation(value: ConsultValue): string {
  if (value.status === 'timeout') return `The architect did not answer in time (${value.rulingId}). No constraints apply; proceed with your own judgment or consult again with a narrower question.`
  if (value.status === 'no-submission') return `The architect ended without a Ruling (${value.rulingId}). No constraints apply; proceed with your own judgment or consult again with a narrower question.`
  const lines = [`Ruling ${value.rulingId}: ${value.summary ?? ''}`]
  if (value.constraints.length > 0) {
    lines.push('', 'Binding constraints:')
    for (const [index, constraint] of value.constraints.entries()) {
      const cites = constraint.citations.map(citation => `${citation.path}#${citation.anchor}`).join(', ')
      lines.push(`${index + 1}. ${constraint.statement} (${cites})`)
    }
  } else {
    lines.push('', 'No binding constraints.')
  }
  if (value.unresolved.length > 0) {
    lines.push('', 'Unresolved, not binding:')
    for (const point of value.unresolved) lines.push(`- ${point.statement}${point.reason === undefined ? '' : ` (${point.reason})`}`)
  }
  if (value.proposedEdits.length > 0) {
    lines.push('', 'Proposed record changes, waiting for the user to review and apply:')
    for (const edit of value.proposedEdits) lines.push(`- ${edit.section}: ${edit.rationale}`)
    lines.push('Until the user applies one and it is committed on the main branch or accepted, the current text governs.')
  }
  return lines.join('\n')
}

/** A Ruling awaiting its tool result, keyed by the consulting call's execution token. */
interface PendingRecord {
  readonly cwd: string
  readonly workerSession: SessionId
  readonly result: Extract<ConsultResult, { kind: 'ruling' }>
}

/**
 * Register `consult_architect`, `appeal_ruling`, and the worker guidance.
 * @param ctx - plugin context with `architecture`, `tools`, and `systemPrompt`.
 */
export function apply(ctx: Context): void {
  const pending = new Map<ToolExecutionToken, PendingRecord>()
  // The record follows the final tool result, so the dashboard never lists a Ruling the worker did not receive.
  ctx.on('tools/result', (exec, result) => {
    const record = pending.get(exec.token)
    pending.delete(exec.token)
    if (record === undefined || result.isError) return
    void ctx.architecture.recordRuling(record.cwd, {
      ruling: record.result.ruling,
      workerSession: record.workerSession,
      architectSession: record.result.session,
      revision: record.result.revision,
    }).catch((error: unknown) => {
      ctx.logger.warn(`architecture: recording Ruling ${record.result.ruling.id} failed: ${String(error)}`)
    })
  })
  // A Session outside a git or jj checkout cannot consult or appeal, so it sees neither tool nor their guidance.
  ctx.on('agent/created', ({ agent }) => {
    const cwd = agent.session.header.cwd
    if (cwd !== undefined && ctx.architecture.checkout(cwd) !== undefined) return undefined
    agent.ctx.effect(() => agent.ctx.tools.restrict({ deny: [CONSULT_ARCHITECT_TOOL, APPEAL_RULING_TOOL] }), 'architecture: worker tools outside version control')
    return undefined
  })
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:consult-architect',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    // An agent whose tools hide consult_architect (an architect, a consultation) gets no worker guidance.
    text: context => ctx.tools.get(CONSULT_ARCHITECT_TOOL, context.scope) === undefined ? '' : WORKER_POLICY,
  }), 'architecture: worker guidance')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: CONSULT_ARCHITECT_TOOL,
    description: 'Ask the architecture agent a design question about this workspace. Returns a Ruling: binding constraints that cite committed architecture sections, and unresolved points that do not bind. The call can take minutes.',
    parameters: {
      question: { type: 'string', required: true, description: 'The concrete design question, including the change you intend.' },
      scope: { type: 'array', items: { type: 'string' }, description: 'Paths or component names the question concerns.' },
    },
    output: {
      schema: CONSULT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderConsultation(value) }],
    },
    async execute(args, exec) {
      if (args.question.trim().length === 0) throw new Error('question must be a non-empty string')
      const worker = exec.agent
      if (worker === undefined) throw new Error('consult_architect requires a calling agent')
      const result = await ctx.architecture.consult({ worker, question: args.question, scope: args.scope ?? [], signal: exec.signal })
      const cwd = worker.session.header.cwd
      if (result.kind === 'ruling' && cwd !== undefined) pending.set(exec.token, { cwd, workerSession: worker.id, result })
      return consultValue(result)
    },
  })), 'architecture: consult_architect')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: APPEAL_RULING_TOOL,
    description: 'Appeal a Ruling you received from consult_architect when you have concrete evidence that one of its constraints is wrong for your change. The user decides; you receive the decision as a message. The Ruling stays binding until then.',
    parameters: {
      rulingId: { type: 'string', required: true, description: 'The Ruling id from the consult_architect result.' },
      reason: { type: 'string', required: true, description: 'Which constraint is wrong for this change, and why.' },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Paths, test names, error messages, or quotes that support the reason.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { appealId: { type: 'string', required: true }, rulingId: { type: 'string', required: true } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Appeal ${value.appealId} filed against Ruling ${value.rulingId}. The Ruling stays binding until the user decides; the decision arrives as a message.`,
      }],
    },
    async execute(args, exec) {
      if (args.reason.trim().length === 0) throw new Error('reason must be a non-empty string')
      const worker = exec.agent
      const cwd = worker?.session.header.cwd
      if (worker === undefined || cwd === undefined) throw new Error('appeal_ruling requires a calling agent with a working directory')
      const appeal = await ctx.architecture.appeal({
        cwd,
        rulingId: brandString<RulingId>(args.rulingId),
        workerSession: worker.id,
        reason: args.reason,
        evidence: args.evidence ?? [],
      })
      return { appealId: appeal.id, rulingId: appeal.rulingId }
    },
  })), 'architecture: appeal_ruling')
}
