/**
 * Worker-side architecture tools: `consult_architect` asks the architect a
 * question and returns a binding Ruling. Mount this plugin in worker presets;
 * the architect preset mounts `./architect` instead.
 * @module @deepseek-ai/dsh-experimental-tool-architecture
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { ConsultResult, Ruling } from '@deepseek-ai/dsh-experimental-architecture'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-architecture'
/** Services required by the worker tools. */
export const inject = ['architecture', 'tools', 'systemPrompt']

/** Model-facing guidance for workers. */
export const WORKER_POLICY = [
  'This workspace keeps its architecture in committed documents. Before a change that adds or moves a responsibility between modules, changes a public interface or data format, or introduces a new dependency or pattern, call `consult_architect` with the concrete question and the paths involved.',
  'A Ruling\'s constraints are binding: follow them even when a local shortcut looks easier. Unresolved points are not constraints; decide them yourself or ask the user.',
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
  },
} as const

type ConsultValue = InferValue<typeof CONSULT_OUTPUT>

/**
 * Project a consultation result onto the canonical tool value.
 * @param result - the service's consultation result.
 * @returns the value the model and PTC code receive.
 */
export function consultValue(result: ConsultResult): ConsultValue {
  if (result.kind !== 'ruling') return { status: result.kind, rulingId: result.id, constraints: [], unresolved: [] }
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
  return lines.join('\n')
}

/**
 * Register `consult_architect` and the worker guidance.
 * @param ctx - plugin context with `architecture`, `tools`, and `systemPrompt`.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:consult-architect',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: WORKER_POLICY,
  }), 'architecture: worker guidance')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'consult_architect',
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
      if (exec.agent === undefined) throw new Error('consult_architect requires a calling agent')
      return consultValue(await ctx.architecture.consult({
        worker: exec.agent,
        question: args.question,
        scope: args.scope ?? [],
        signal: exec.signal,
      }))
    },
  })), 'architecture: consult_architect')
}
