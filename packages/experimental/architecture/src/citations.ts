/**
 * Verify architect citations against the primary worktree and `mainBranch`.
 * A citation `path#anchor` is citable when the section exists in the current
 * index and the same section, with the same content hash, exists in the file
 * as committed at the tip of `mainBranch`. The verified citation records that
 * hash, so a Ruling names the exact text it relied on.
 * @module @deepseek-ai/dsh-experimental-architecture/citations
 */

import { indexSections } from './sections.ts'
import type { ArchitectureIndex, Citation, CitationFailure, IndexedSection, SourcePath } from './types.ts'

/** Reads a source file as committed on `mainBranch`. */
export type ReadCommitted = (path: SourcePath) => Promise<string | undefined>

/** Outcome of verifying one citation. */
export type CitationCheck =
  | { readonly kind: 'verified'; readonly citation: Citation }
  | { readonly kind: 'failed'; readonly failure: CitationFailure }

/**
 * Split a `path#anchor` reference.
 * @param cite - citation text as submitted.
 * @returns the path and anchor, or undefined without exactly one `#` separating two non-empty parts.
 */
export function parseCite(cite: string): { path: string; anchor: string } | undefined {
  const at = cite.indexOf('#')
  if (at <= 0 || at === cite.length - 1 || cite.indexOf('#', at + 1) !== -1) return undefined
  return { path: cite.slice(0, at), anchor: cite.slice(at + 1) }
}

/** Whether the user accepted this exact section content in the dashboard. */
export type IsAccepted = (section: Pick<IndexedSection, 'path' | 'anchor' | 'hash'>) => boolean

/**
 * Verify citations against one index and the committed sources. A section is
 * citable when its current content is committed on `mainBranch` or the user
 * accepted that exact content; without a main branch only accepted content is citable.
 * @param index - current index of the primary worktree.
 * @param cites - `path#anchor` references.
 * @param mainBranch - branch whose committed text is authoritative, or undefined when the repository has none.
 * @param readCommitted - reads a source as committed on `mainBranch`.
 * @param isAccepted - whether the user accepted a section's current content.
 * @returns one check per citation, in input order.
 */
export async function verifyCitations(
  index: ArchitectureIndex,
  cites: readonly string[],
  mainBranch: string | undefined,
  readCommitted: ReadCommitted,
  isAccepted: IsAccepted,
): Promise<CitationCheck[]> {
  const committedHashes = async (path: SourcePath): Promise<Map<string, string>> => {
    const text = await readCommitted(path)
    return new Map(text === undefined ? [] : indexSections(path, text).map(section => [section.anchor, section.hash]))
  }
  const checks: CitationCheck[] = []
  for (const cite of cites) {
    const parsed = parseCite(cite)
    if (parsed === undefined) {
      checks.push({ kind: 'failed', failure: { kind: 'malformed', cite } })
      continue
    }
    const section = index.sections.find(entry => entry.path === parsed.path && entry.anchor === parsed.anchor)
    if (section === undefined) {
      checks.push({ kind: 'failed', failure: { kind: 'unknown-section', cite } })
      continue
    }
    if (!isAccepted(section) && (mainBranch === undefined || (await committedHashes(section.path)).get(section.anchor) !== section.hash)) {
      checks.push({ kind: 'failed', failure: { kind: 'uncommitted', cite, mainBranch } })
      continue
    }
    checks.push({ kind: 'verified', citation: { path: section.path, anchor: section.anchor, hash: section.hash } })
  }
  return checks
}

/**
 * Explain a citation failure to the architect or a worker.
 * @param failure - the failure.
 * @returns one sentence naming the citation and the failed condition.
 */
export function describeCitationFailure(failure: CitationFailure): string {
  switch (failure.kind) {
    case 'malformed':
      return `"${failure.cite}" is not a path#anchor reference`
    case 'unknown-section':
      return `"${failure.cite}" names no indexed architecture section`
    case 'uncommitted':
      return failure.mainBranch === undefined
        ? `"${failure.cite}" cannot be checked against a committed version because the repository declares no main branch, and the user has not accepted it`
        : `"${failure.cite}" differs from the section committed on ${failure.mainBranch}, or is not committed there, and the user has not accepted it`
  }
}
