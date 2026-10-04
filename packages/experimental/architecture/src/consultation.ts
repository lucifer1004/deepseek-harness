/**
 * Run one consultation: create an architect agent as a hidden child of the
 * worker's Session, give it a scoped `submit_ruling` tool, send the question,
 * and wait for a valid submission, the consultation deadline, or cancellation.
 * The submission is validated into a Ruling before the call resolves, and the
 * architect agent is disposed in every outcome.
 * @module @deepseek-ai/dsh-experimental-architecture/consultation
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { RulingSubmission } from './ruling.ts'
import type { RulingId } from './types.ts'

/** Model-facing name of the architect's answer tool inside a consultation. */
export const SUBMIT_RULING_TOOL = 'submit_ruling'

/**
 * The time budget the architect is given, from the run's own bounds.
 * @param timeoutMs - the hard stop.
 * @returns the prompt paragraph.
 */
export function consultationBudget(timeoutMs: number): string {
  return `You have ${String(Math.floor(timeoutMs / 1000))} seconds for this consultation, after which it ends with no answer. Read only what the question needs, and call \`submit_ruling\` before the time is up; an answer with open points in \`unresolved\` is worth more than none.`
}

/**
 * The notice the architect receives at `nudgeMs`.
 * @param remainingMs - milliseconds left before the hard stop.
 * @returns the message text.
 */
export function consultationDeadlineNotice(remainingMs: number): string {
  return `About ${String(Math.ceil(remainingMs / 1000))} seconds remain. Stop reading and call \`submit_ruling\` now with what you have; put every point you could not settle in \`unresolved\`.`
}

/** Instruction appended to the consultation agent's system prompt, before its time budget. */
export const CONSULTATION_INSTRUCTION = [
  'You are answering one consultation from a worker agent. Read the architecture sources and the code you need, then call `submit_ruling` exactly once.',
  'Put a requirement in `constraints` only when an architecture section states or directly implies it, and cite every such section as `path#anchor` from `architecture_index`. The host drops a citation that does not match the section committed on the main branch, and turns its constraint into an unresolved point.',
  'Put judgments without a citable section, and questions the user must decide, in `unresolved`. Do not answer with plain text: only the `submit_ruling` call counts.',
  'You cannot change the record. When the answer needs a section of the record rewritten, put the complete new section in `proposedEdits` with the hash `architecture_read` returned, and keep it out of `summary`. The user reviews each proposed edit and applies it or not; until the result is committed on the main branch or accepted, constraints must cite the sections as they stand. A new file is not a proposed edit; name it in `unresolved`.',
].join('\n\n')

/** Inputs of one consultation run. */
export interface ConsultationRun {
  /** Agent registry that creates the architect agent. */
  readonly agents: Context['agents']
  /** Preset registry that composes the architect agent. */
  readonly presets: Context['agentPresets']
  /** The worker whose Session owns the consultation. */
  readonly worker: Agent
  /** Working directory of the worker's Session, which the architect shares. */
  readonly cwd: string
  /** Question text sent to the architect. */
  readonly prompt: string
  /** Preset the architect agent mounts. */
  readonly preset: string
  /** Tool names the architect agent keeps from its preset. */
  readonly tools: readonly string[]
  /** Model the architect runs on; undefined runs it on the worker's model. */
  readonly model: Pick<AgentOptions, 'provider' | 'model' | 'reasoningEffort'> | undefined
  /** Milliseconds to wait for a submission. */
  readonly timeoutMs: number
  /** Milliseconds into the run at which the architect is told to submit now; less than `timeoutMs`. */
  readonly nudgeMs: number
  /** Worker-side cancellation, such as the consulting tool call's signal. */
  readonly signal: AbortSignal
}

/** How a consultation run ended. */
export type ConsultationOutcome =
  | { readonly kind: 'submitted'; readonly id: RulingId; readonly submission: RulingSubmission; readonly session: SessionId }
  | { readonly kind: 'timeout'; readonly id: RulingId; readonly session: SessionId }
  | { readonly kind: 'no-submission'; readonly id: RulingId; readonly session: SessionId }

const SUBMISSION_PARAMETERS = {
  summary: { type: 'string', required: true, description: 'Short answer to the worker\'s question.' },
  constraints: {
    type: 'array',
    required: true,
    description: 'Binding requirements the worker must follow. Each needs at least one citation.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        statement: { type: 'string', required: true, description: 'The requirement, in imperative form.' },
        cites: { type: 'array', required: true, items: { type: 'string' }, description: 'Supporting sections as path#anchor.' },
      },
    },
  },
  unresolved: {
    type: 'array',
    required: true,
    items: { type: 'string' },
    description: 'Judgments without a citable section, and questions for the user.',
  },
  proposedEdits: {
    type: 'array',
    description: 'Section rewrites for the user to review. Each replaces one indexed section; omit when the record needs no change.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cite: { type: 'string', required: true, description: 'Section to replace as path#anchor.' },
        hash: { type: 'string', required: true, description: 'Hash of the section as architecture_read returned it.' },
        content: { type: 'string', required: true, description: 'The complete new section, from its heading through its last line.' },
        rationale: { type: 'string', required: true, description: 'Why the section should change.' },
      },
    },
  },
} as const

/**
 * Architect tools a consultation withholds. The user takes no part in a consultation, so the architect does not ask
 * the user, and a worker's report of the user's consent does not authorize a write. The record changes only when the
 * user agrees in an Architecture Session or applies a proposed edit from the Ruling in the dashboard.
 */
export const CONSULTATION_WITHHELD_TOOLS: readonly string[] = ['architecture_edit', 'ask_user_question']

/**
 * Keep only the configured architect tools among the tools an agent inherits, minus the tools a consultation
 * withholds. Configured names the composition does not provide are skipped, because `tools.restrict()` rejects
 * unknown names and tool plugins may be disabled in one composition.
 * @param agentCtx - the agent's scoped context, after its preset is mounted.
 * @param agent - the agent being created; its scope key.
 * @param tools - configured architect tool names.
 */
export function restrictToArchitectTools(agentCtx: Context, agent: Agent, tools: readonly string[]): void {
  const visible = new Set(agentCtx.tools.schemas(agent).map(schema => schema.name))
  agentCtx.tools.restrict({ allow: tools.filter(name => visible.has(name) && !CONSULTATION_WITHHELD_TOOLS.includes(name)) })
}

/** The worker's options with its model route, including reasoning effort, replaced by `model`. */
function withModel(options: AgentOptions, model: NonNullable<ConsultationRun['model']>): AgentOptions {
  const { provider: _provider, model: _model, reasoningEffort: _effort, ...rest } = options
  return { ...rest, ...model }
}

/**
 * Run one consultation to its outcome.
 * @param run - registries, worker, prompt, composition, and bounds.
 * @returns the submission, or the reason there is none.
 * @throws when agent creation fails or `run.signal` aborts.
 */
export async function runConsultation(run: ConsultationRun): Promise<ConsultationOutcome> {
  run.signal.throwIfAborted()
  const id = brandString<RulingId>(`ruling-${randomUUID()}`)
  const sessionId = brandString<SessionId>(`architect-${randomUUID()}`)
  let submission: RulingSubmission | undefined
  const header = run.worker.session.header
  const handle = await run.agents.create({
    sessionId,
    parentAgent: run.worker,
    meta: {
      cwd: run.cwd,
      parentSession: header.id,
      origin: 'subagent',
      agentPreset: run.preset,
    },
    // A configured architect model replaces the worker's model route, including its reasoning effort.
    agentOptions: run.model === undefined ? { ...run.worker.options } : withModel(run.worker.options, run.model),
    signal: run.signal,
    setup: async (agentCtx, agent) => {
      await run.presets.mount(agentCtx, run.preset)
      restrictToArchitectTools(agentCtx, agent, run.tools)
      agentCtx.tools.register(defineTool({
        name: SUBMIT_RULING_TOOL,
        description: 'Submit your answer to the consultation. Call this exactly once, when your answer is complete.',
        parameters: SUBMISSION_PARAMETERS,
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { recorded: { type: 'boolean', required: true } } },
          render: () => [{ type: 'text', text: 'Ruling submitted.' }],
        },
        execute(args, exec) {
          submission ??= {
            summary: args.summary,
            constraints: args.constraints.map(entry => ({ statement: entry.statement, cites: entry.cites })),
            unresolved: args.unresolved,
            edits: (args.proposedEdits ?? []).map(({ cite, hash, content, rationale }) => ({ cite, hash, content, rationale })),
          }
          exec.concludeTurn()
          return Promise.resolve({ recorded: true })
        },
      }))
      agentCtx.tools.guard(exec => submission === undefined ? undefined : `the ruling is already submitted, so ${exec.name} is not executed`)
      agentCtx.systemPrompt.section({
        name: `tool:${SUBMIT_RULING_TOOL}`,
        order: agentCtx.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT'),
        // The budget comes from the same run bounds that arm the timers below.
        text: `${CONSULTATION_INSTRUCTION}\n\n${consultationBudget(run.timeoutMs)}`,
      })
    },
  })
  const architect = handle.agent
  const deadline = AbortSignal.timeout(run.timeoutMs)
  const stop = AbortSignal.any([run.signal, deadline])
  const onStop = (): void => { architect.cancel({ kind: 'parent' }) }
  stop.addEventListener('abort', onStop, { once: true })
  // The notice is steered into the architect's own Session, so its log records it. A submission concludes the turn,
  // and the timer is cleared once the turn ends, so no notice follows a submission.
  const nudge = setTimeout(() => {
    const text = consultationDeadlineNotice(run.timeoutMs - run.nudgeMs)
    architect.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'architecture', deadline: true } }))
  }, run.nudgeMs)
  try {
    architect.followup(createUserMessage({ content: [{ type: 'text', text: run.prompt }], source: { kind: 'user' } }))
    await architect.whenIdle()
  } finally {
    clearTimeout(nudge)
    stop.removeEventListener('abort', onStop)
    await handle.dispose()
  }
  run.signal.throwIfAborted()
  if (submission !== undefined) return { kind: 'submitted', id, submission, session: sessionId }
  return deadline.aborted ? { kind: 'timeout', id, session: sessionId } : { kind: 'no-submission', id, session: sessionId }
}
