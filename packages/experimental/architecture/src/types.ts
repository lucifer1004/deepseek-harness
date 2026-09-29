/** Public types of the workspace architecture sources, section index, and edit rule. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Plugin configuration for `ctx.architecture`. */
export interface Config {
  /** Branch whose primary-worktree checkout is the only place architecture sources change. */
  mainBranch: string
  /** Workspace-relative path of the architecture manifest. */
  manifestPath: string
  /** Workspace-relative directory holding local architecture entries. */
  localDirectory: string
  /** Agent preset whose agents may run only `architectTools`. */
  architectPreset: string
  /** Tool names an agent composed with `architectPreset` may run; every other call is denied. */
  architectTools: string[]
  /** Milliseconds a git command may run before it is terminated. */
  gitTimeoutMs: number
  /** Byte cap on one manifest source read while indexing. */
  maxSourceBytes: number
  /** Milliseconds a consultation waits for the architect to submit a Ruling. */
  consultTimeoutMs: number
}

/** Workspace-relative POSIX path of one architecture source file. */
export type SourcePath = Branded<'ArchitectureSourcePath'>

/** Lowercase hexadecimal SHA-256 of one section's normalized content. */
export type SectionHash = Branded<'ArchitectureSectionHash'>

/** Validated contents of the architecture manifest. */
export interface ArchitectureManifest {
  /** Workspace-relative POSIX globs naming the authoritative source documents. */
  readonly sources: readonly string[]
  /** Workspace-relative POSIX globs removed from `sources`. */
  readonly exclude: readonly string[]
}

/** One heading-delimited section of a Markdown source. */
export interface IndexedSection {
  /** Source file containing the section. */
  readonly path: SourcePath
  /** GitHub-style anchor of the heading, unique within its file; `''` for text before the first heading. */
  readonly anchor: string
  /** Heading text without the leading `#` marks; `''` for text before the first heading. */
  readonly title: string
  /** Heading level from 1 to 6; 0 for text before the first heading. */
  readonly level: number
  /** One-based line of the heading, or 1 for text before the first heading. */
  readonly line: number
  /** One-based last line of the section, inclusive. */
  readonly endLine: number
  /** Hash of the section's content, from its heading through the line before the next heading of any level. */
  readonly hash: SectionHash
}

/** Why an architecture source could not be indexed. */
export interface IndexDiagnostic {
  /** Workspace-relative path the diagnostic concerns. */
  readonly path: string
  /** Human-readable reason. */
  readonly message: string
}

/** A rebuildable index of the manifest sources in one workspace. */
export interface ArchitectureIndex {
  /** Canonical repository root the index was built from. */
  readonly root: string
  /** Every indexed source path, sorted. */
  readonly sources: readonly SourcePath[]
  /** Every section of every source, in source then file order. */
  readonly sections: readonly IndexedSection[]
  /** Sources that matched the manifest but could not be read or parsed. */
  readonly diagnostics: readonly IndexDiagnostic[]
}

/** The repository checkout a Session works in. */
export interface CheckoutState {
  /** Canonical top-level directory of this checkout. */
  readonly root: string
  /** Canonical top-level directory of the repository's primary worktree. */
  readonly primaryRoot: string
  /** Whether this checkout is the primary worktree. */
  readonly isPrimary: boolean
  /** Checked-out branch name, or undefined on a detached `HEAD`. */
  readonly branch: string | undefined
}

/** Why the edit rule refused an architecture write. */
export type EditRefusal =
  | { readonly kind: 'not-repository'; readonly cwd: string }
  | { readonly kind: 'linked-worktree'; readonly root: string; readonly primaryRoot: string }
  | { readonly kind: 'wrong-branch'; readonly branch: string | undefined; readonly mainBranch: string }
  | { readonly kind: 'not-protected'; readonly path: string }
  | { readonly kind: 'unknown-section'; readonly path: string; readonly anchor: string }
  | { readonly kind: 'stale-section'; readonly path: string; readonly anchor: string; readonly hash: SectionHash }

/** One validated write of an architecture file or one of its sections. */
export interface ArchitectureEditRequest {
  /** Workspace directory of the requesting Session; resolves `path` and locates the checkout. */
  readonly cwd: string
  /** Target file, relative to the repository root or absolute inside it. */
  readonly path: string
  /**
   * Indexed section to replace, from its heading through its last line.
   * Omitted: `content` replaces or creates the whole file.
   */
  readonly anchor?: string | undefined
  /**
   * Content hash of the section the caller read; the edit is refused when the
   * section changed since. Requires `anchor`.
   */
  readonly expectedHash?: string | undefined
  /** New UTF-8 content of the file, or of the section including its heading. */
  readonly content: string
  /** Cancels the write and the index rebuild. */
  readonly signal?: AbortSignal | undefined
}

/** Outcome of {@link ArchitectureEditRequest}. */
export type ArchitectureEditResult =
  | { readonly kind: 'written'; readonly path: string }
  | { readonly kind: 'refused'; readonly refusal: EditRefusal }

/** Opaque identity of one Ruling. */
export type RulingId = Branded<'ArchitectureRulingId'>

/** A reference to one indexed section at an exact content version. */
export interface Citation {
  /** Source file of the section. */
  readonly path: SourcePath
  /** Anchor of the section within the file. */
  readonly anchor: string
  /** Content hash the citing text relied on. */
  readonly hash: SectionHash
}

/** A binding requirement a worker must follow. */
export interface Constraint {
  /** The requirement, in imperative form. */
  readonly statement: string
  /** Sections that establish the requirement; each was verified when the Ruling was issued. */
  readonly citations: readonly Citation[]
}

/** A point the architect could not settle from citable sources. */
export interface UnresolvedPoint {
  /** The open question or unsupported judgment. */
  readonly statement: string
  /** Why the point is unresolved; set by the host when it demotes a constraint. */
  readonly reason?: string
}

/** An architect's answer to one consultation after host validation. */
export interface Ruling {
  /** Identity for later appeals. */
  readonly id: RulingId
  /** The worker's question. */
  readonly question: string
  /** Paths or components the worker named. */
  readonly scope: readonly string[]
  /** Short answer in the architect's words. */
  readonly summary: string
  /** Binding constraints whose every citation verified. */
  readonly constraints: readonly Constraint[]
  /** Points without citable support, including demoted constraints. */
  readonly unresolved: readonly UnresolvedPoint[]
}

/** A constraint as the architect submitted it, before verification. */
export interface ProposedConstraint {
  /** The requirement, in imperative form. */
  readonly statement: string
  /** Sections the architect cites as `path#anchor`. */
  readonly cites: readonly string[]
}

/** Why one citation failed verification. */
export type CitationFailure =
  | { readonly kind: 'malformed'; readonly cite: string }
  | { readonly kind: 'unknown-section'; readonly cite: string }
  | { readonly kind: 'uncommitted'; readonly cite: string; readonly mainBranch: string }

/** One worker consultation. */
export interface ConsultRequest {
  /** The consulting worker; its Session owns the architect child and supplies the working directory. */
  readonly worker: Agent
  /** The question, in the worker's words. */
  readonly question: string
  /** Paths or components the question concerns. */
  readonly scope: readonly string[]
  /** Cancels the consultation, such as the consulting tool call's signal. */
  readonly signal: AbortSignal
}

/** Outcome of {@link ConsultRequest}. */
export type ConsultResult =
  | { readonly kind: 'ruling'; readonly ruling: Ruling; readonly session: SessionId }
  | { readonly kind: 'timeout'; readonly id: RulingId; readonly session: SessionId }
  | { readonly kind: 'no-submission'; readonly id: RulingId; readonly session: SessionId }
