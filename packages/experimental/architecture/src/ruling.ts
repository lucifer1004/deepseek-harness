/**
 * Turn an architect's submission into a Ruling. Every proposed constraint
 * keeps its binding form only when all of its citations verify; a constraint
 * with no citation or a failed citation becomes an unresolved point that
 * states why, so an unsupported judgment never binds a worker.
 * @module @deepseek-ai/dsh-experimental-architecture/ruling
 */

import { describeCitationFailure, verifyCitations, type IsAccepted, type ReadCommitted } from './citations.ts'
import type { ArchitectureIndex, Citation, Constraint, ProposedConstraint, Ruling, RulingId, UnresolvedPoint } from './types.ts'

/** An architect's submission as received from the consultation tool. */
export interface RulingSubmission {
  /** Short answer. */
  readonly summary: string
  /** Proposed binding constraints with their citations. */
  readonly constraints: readonly ProposedConstraint[]
  /** Points the architect itself left open. */
  readonly unresolved: readonly string[]
}

/** The consultation a Ruling answers. */
export interface RulingRequest {
  /** Identity assigned to the Ruling. */
  readonly id: RulingId
  /** The worker's question. */
  readonly question: string
  /** Paths or components the worker named. */
  readonly scope: readonly string[]
}

/**
 * Validate a submission against the index and the committed sources.
 * @param request - identity, question, and scope.
 * @param submission - the architect's submission.
 * @param index - current index of the primary worktree.
 * @param mainBranch - branch whose committed text is authoritative.
 * @param readCommitted - reads a source as committed on `mainBranch`.
 * @param isAccepted - whether the user accepted a section's current content.
 * @returns the Ruling with only verified constraints.
 */
export async function validateRuling(
  request: RulingRequest,
  submission: RulingSubmission,
  index: ArchitectureIndex,
  mainBranch: string,
  readCommitted: ReadCommitted,
  isAccepted: IsAccepted,
): Promise<Ruling> {
  // One committed read per source file for the whole Ruling.
  const reads = new Map<string, Promise<string | undefined>>()
  const readOnce: ReadCommitted = (path) => {
    let read = reads.get(path)
    if (read === undefined) {
      read = readCommitted(path)
      reads.set(path, read)
    }
    return read
  }
  const constraints: Constraint[] = []
  const unresolved: UnresolvedPoint[] = submission.unresolved.map(statement => ({ statement }))
  for (const proposed of submission.constraints) {
    if (proposed.cites.length === 0) {
      unresolved.push({ statement: proposed.statement, reason: 'no citation to an architecture section' })
      continue
    }
    const checks = await verifyCitations(index, proposed.cites, mainBranch, readOnce, isAccepted)
    const citations: Citation[] = []
    const failures: string[] = []
    for (const check of checks) {
      if (check.kind === 'verified') citations.push(check.citation)
      else failures.push(describeCitationFailure(check.failure))
    }
    if (failures.length > 0) unresolved.push({ statement: proposed.statement, reason: failures.join('; ') })
    else constraints.push({ statement: proposed.statement, citations })
  }
  return { id: request.id, question: request.question, scope: request.scope, summary: submission.summary, constraints, unresolved }
}
