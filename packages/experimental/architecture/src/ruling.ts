/**
 * Turn an architect's submission into a Ruling. Every proposed constraint
 * keeps its binding form only when all of its citations verify; a constraint
 * with no citation or a failed citation becomes an unresolved point that
 * states why, so an unsupported judgment never binds a worker. A proposed
 * edit is kept only when it names an indexed section at its current hash.
 * @module @deepseek-ai/dsh-experimental-architecture/ruling
 */

import { describeCitationFailure, parseCite, verifyCitations, type IsAccepted, type ReadCommitted } from './citations.ts'
import type { ArchitectureIndex, Citation, Constraint, ProposedConstraint, ProposedEdit, Ruling, RulingId, SubmittedEdit, UnresolvedPoint } from './types.ts'

/** An architect's submission as received from the consultation tool. */
export interface RulingSubmission {
  /** Short answer. */
  readonly summary: string
  /** Proposed binding constraints with their citations. */
  readonly constraints: readonly ProposedConstraint[]
  /** Points the architect itself left open. */
  readonly unresolved: readonly string[]
  /** Section replacements the architect proposes. */
  readonly edits: readonly SubmittedEdit[]
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
 * @param mainBranch - branch whose committed text is authoritative, or undefined when the repository has none.
 * @param readCommitted - reads a source as committed on `mainBranch`.
 * @param isAccepted - whether the user accepted a section's current content.
 * @returns the Ruling with only verified constraints.
 */
export async function validateRuling(
  request: RulingRequest,
  submission: RulingSubmission,
  index: ArchitectureIndex,
  mainBranch: string | undefined,
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
  const proposedEdits: ProposedEdit[] = []
  for (const edit of submission.edits) {
    const checked = checkEdit(index, edit)
    if (typeof checked === 'string') unresolved.push({ statement: `Proposed edit of ${edit.cite}: ${edit.rationale}`, reason: checked })
    else proposedEdits.push(checked)
  }
  const { id, question, scope } = request
  return { id, question, scope, summary: submission.summary, constraints, unresolved, proposedEdits }
}

/** The validated edit, or why it was dropped. */
function checkEdit(index: ArchitectureIndex, edit: SubmittedEdit): ProposedEdit | string {
  const target = parseCite(edit.cite)
  if (target === undefined) return `"${edit.cite}" is not a path#anchor reference`
  const section = index.sections.find(entry => entry.path === target.path && entry.anchor === target.anchor)
  if (section === undefined) return `${edit.cite} is not an indexed section`
  if (section.hash !== edit.hash) return `${edit.cite} changed since it was read; its current hash is ${section.hash}`
  if (edit.content.trim().length === 0) return 'the proposed content is empty'
  return { path: section.path, anchor: section.anchor, hash: section.hash, content: edit.content, rationale: edit.rationale }
}
