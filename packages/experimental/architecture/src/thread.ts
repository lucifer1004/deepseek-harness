/**
 * Consultation threads: the state of one architect Session derived from its log alone, so a restart neither loses
 * nor reuses a Ruling id. The log records each turn's question with the Ruling id the turn issues under, and each
 * `submit_ruling` call; the model route is recorded once, when the consultation starts.
 * @module @deepseek-ai/dsh-experimental-architecture/thread
 */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { RulingId } from './types.ts'

/** The model route a consultation runs every turn on, recorded when it starts. */
export interface ConsultationRoute {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: ReasoningEffortId
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The model route of a consultation's architect Session, appended once when the consultation starts and read
     * when a later turn resumes it. Log-only: it carries no `surfaceOp`, never enters model history, and survives
     * compaction.
     */
    'architecture/consultation': { readonly version: 1; readonly route: ConsultationRoute }
  }
}

/** What the log of one architect Session says about its consultation. */
export interface ConsultationThread {
  /** The route recorded when the consultation started. */
  readonly route: ConsultationRoute
  /** The Ruling id of the last turn whose question has no later submission; undefined when every turn submitted. */
  readonly pendingRulingId: RulingId | undefined
}

/**
 * Derive a consultation's state from its architect Session log.
 * @param events - the architect Session's events after its inherited prefix.
 * @param submitTool - the name of the architect's answer tool.
 * @returns the thread state, or undefined when the log records no consultation.
 */
export function foldConsultation(events: readonly SessionEvent[], submitTool: string): ConsultationThread | undefined {
  let route: ConsultationRoute | undefined
  let pending: RulingId | undefined
  for (const event of events) {
    switch (event.type) {
      case 'architecture/consultation':
        route = event.data.route
        break
      case 'user/message': {
        const source = event.data.source
        if (source.kind === 'architecture' && 'rulingId' in source) pending = source.rulingId
        break
      }
      case 'tool/call':
        if (event.data.name === submitTool) pending = undefined
        break
      default:
        // Every other event leaves the route and the pending id unchanged.
        break
    }
  }
  return route === undefined ? undefined : { route, pendingRulingId: pending }
}

/**
 * The route fields of agent options, to record when a consultation starts.
 * @param options - the options the architect is created with.
 * @returns the provider, model, and reasoning effort that are set.
 */
export function routeOf(options: AgentOptions): ConsultationRoute {
  return {
    ...options.provider === undefined ? {} : { provider: options.provider },
    ...options.model === undefined ? {} : { model: options.model },
    ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
  }
}
