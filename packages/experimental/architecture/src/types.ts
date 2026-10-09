/** Public types of the workspace architecture sources, section index, and edit rule. */

import type { Volatile } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Plugin configuration for `ctx.architecture`. */
export interface Config {
  /** Main branch of a repository whose manifest declares none; unset leaves such a repository without one. */
  mainBranch?: string
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
  consultNudgeMs: number
  /** Provider route of the consulted architect; unset runs it on the consulting worker's model. Read at each consultation. */
  architectProvider: Volatile<string | undefined>
  /** Model of the consulted architect, used together with `architectProvider`. Read at each consultation. */
  architectModel: Volatile<string | undefined>
  /** Reasoning effort of the consulted architect; unset keeps the model's default. Read at each consultation. */
  architectReasoningEffort: Volatile<string | undefined>
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
  /** The repository's main branch: only its primary-worktree checkout changes architecture sources. */
  readonly mainBranch: string | undefined
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

/** Version-control system of a checkout. A colocated Jujutsu repository is `jj`. */
export type VcsKind = 'git' | 'jj'

/** The repository checkout a Session works in. */
export interface CheckoutState {
  /** Version-control system that owns the checkout. */
  readonly vcs: VcsKind
  /** Canonical top-level directory of this checkout. */
  readonly root: string
  /** Canonical top-level directory of the repository's primary worktree or primary jj workspace. */
  readonly primaryRoot: string
  /** Whether this checkout is the primary worktree or primary jj workspace. */
  readonly isPrimary: boolean
  /** Checked-out git branch, or undefined on a detached `HEAD` and in a jj workspace, which has no current branch. */
  readonly branch: string | undefined
}

/** Why the edit rule refused an architecture write. */
export type EditRefusal =
  | { readonly kind: 'not-repository'; readonly cwd: string }
  | { readonly kind: 'linked-worktree'; readonly root: string; readonly primaryRoot: string }
  | { readonly kind: 'unknown-branch'; readonly vcs: VcsKind; readonly branch: string }
  | { readonly kind: 'not-protected'; readonly path: string }
  | { readonly kind: 'unknown-section'; readonly path: string; readonly anchor: string }
  | { readonly kind: 'stale-section'; readonly path: string; readonly anchor: string; readonly hash: SectionHash }

/** One proposed edit of a recorded Ruling, for the user to apply. */
export interface ApplyProposedEditRequest {
  /** Any directory inside the repository. */
  readonly cwd: string
  /** The recorded Ruling that carries the edit. */
  readonly rulingId: RulingId
  /** Index into the Ruling's `proposedEdits`. */
  readonly index: number
  /** Whether to accept the section the write produces, so Rulings may cite it before it is committed. */
  readonly accept: boolean
  /** Cancels the write and the rebuild. */
  readonly signal?: AbortSignal | undefined
}

/** One proposed edit of a recorded Ruling, for the user to dismiss. */
export interface DismissProposedEditRequest {
  /** Any directory inside the repository. */
  readonly cwd: string
  /** The recorded Ruling that carries the edit. */
  readonly rulingId: RulingId
  /** Index into the Ruling's `proposedEdits`. */
  readonly index: number
}

/**
 * Outcome of applying one proposed edit. `acceptance` is present when acceptance was requested: the recorded
 * acceptance, or undefined when the written content is not one indexed section.
 */
export type ApplyProposedEditResult =
  | (Extract<ArchitectureEditResult, { kind: 'written' }> & { readonly acceptance?: Acceptance | undefined })
  | Extract<ArchitectureEditResult, { kind: 'refused' }>

/** The version control of one checkout and its repository's local branches. */
export interface CheckoutBranches {
  readonly vcs: VcsKind
  /** Whether the checkout is the primary worktree or jj workspace, where architecture files change. */
  readonly isPrimary: boolean
  /** Branch or bookmark names the checkout is on now. */
  readonly current: readonly string[]
  /** Every local branch or bookmark, sorted. */
  readonly all: readonly string[]
}

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
  readonly reason?: string | undefined
}

/**
 * A section replacement the architect proposes. It binds no worker and makes nothing citable; it changes the record
 * only when the user applies it.
 */
export interface ProposedEdit {
  /** Section to replace. */
  readonly path: SourcePath
  /** Anchor of the section within the file. */
  readonly anchor: string
  /** Content hash of the section the architect read; applying is refused once the section changed. */
  readonly hash: SectionHash
  /** New text of the section, from its heading through its last line. */
  readonly content: string
  /** Why the architect proposes the change. */
  readonly rationale: string
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
  /** Points without citable support, including demoted constraints and invalid proposed edits. */
  readonly unresolved: readonly UnresolvedPoint[]
  /** Section replacements that validated against the index the Ruling was issued on. */
  readonly proposedEdits: readonly ProposedEdit[]
}

/** A constraint as the architect submitted it, before verification. */
export interface ProposedConstraint {
  /** The requirement, in imperative form. */
  readonly statement: string
  /** Sections the architect cites as `path#anchor`. */
  readonly cites: readonly string[]
}

/** A section replacement as the architect submitted it, before validation. */
export interface SubmittedEdit {
  /** Section to replace as `path#anchor`. */
  readonly cite: string
  /** Content hash of the section the architect read. */
  readonly hash: string
  /** New text of the section, from its heading through its last line. */
  readonly content: string
  /** Why the architect proposes the change. */
  readonly rationale: string
}

/** Why one citation failed verification. */
export type CitationFailure =
  | { readonly kind: 'malformed'; readonly cite: string }
  | { readonly kind: 'unknown-section'; readonly cite: string }
  | { readonly kind: 'uncommitted'; readonly cite: string; readonly mainBranch: string | undefined }

/** Outcome of one consultation. */
export type ConsultResult =
  | { readonly kind: 'ruling'; readonly ruling: Ruling; readonly session: SessionId; readonly revision: string }
  | { readonly kind: 'timeout'; readonly id: RulingId; readonly session: SessionId }
  | { readonly kind: 'no-submission'; readonly id: RulingId; readonly session: SessionId }

/** Opaque identity of one appeal. */
export type AppealId = Branded<'ArchitectureAppealId'>

/** Lifecycle of a recorded Ruling. */
export type RulingStatus = 'issued' | 'appealed' | 'upheld' | 'overturned' | 'excepted'

/**
 * A Ruling as the dashboard records it, written after the consulting tool
 * result is committed to the worker's log. The worker's log stays the
 * authority for what the worker received; this record is a rebuildable copy.
 */
export interface RulingRecord {
  /** Record format version; readers reject another value. */
  readonly version: 1
  /** The Ruling the worker received. */
  readonly ruling: Ruling
  /** Worker Session that consulted. */
  readonly workerSession: SessionId
  /** Architect Session that answered. */
  readonly architectSession: SessionId
  /** Index revision the Ruling was validated against. */
  readonly revision: string
  /** Issue time, Unix milliseconds. */
  readonly issuedAt: number
  /** Current status. */
  readonly status: RulingStatus
  /** Indexes into `ruling.proposedEdits` the user applied, in application order. */
  readonly appliedEdits: readonly number[]
  /** Indexes into `ruling.proposedEdits` the user dismissed; disjoint from `appliedEdits`. */
  readonly dismissedEdits: readonly number[]
}

/** How the user resolved an appeal. */
export type Adjudication =
  | { readonly kind: 'uphold'; readonly note?: string | undefined }
  | { readonly kind: 'overturn'; readonly note?: string | undefined }
  | { readonly kind: 'exception'; readonly scope: string; readonly note?: string | undefined }

/** A worker's appeal against one Ruling, and the user's decision when made. */
export interface AppealRecord {
  /** Record format version; readers reject another value. */
  readonly version: 1
  /** Appeal identity. */
  readonly id: AppealId
  /** Ruling the worker appeals. */
  readonly rulingId: RulingId
  /** Worker Session that appealed and receives the decision. */
  readonly workerSession: SessionId
  /** The worker's reason. */
  readonly reason: string
  /** Evidence the worker cites, such as paths, failing tests, or quotes. */
  readonly evidence: readonly string[]
  /** Filing time, Unix milliseconds. */
  readonly filedAt: number
  /** The user's decision; absent while pending. */
  readonly adjudication?: Adjudication | undefined
  /** Decision time, Unix milliseconds. */
  readonly decidedAt?: number | undefined
  /** Whether the decision reached the worker's Session. */
  readonly delivered: boolean
}

/** The user's acceptance of an uncommitted section, which makes that exact content citable. */
export interface Acceptance {
  /** Source file of the section. */
  readonly path: SourcePath
  /** Anchor of the section. */
  readonly anchor: string
  /** Accepted content hash; any other content of the section is not accepted. */
  readonly hash: SectionHash
  /** Acceptance time, Unix milliseconds. */
  readonly acceptedAt: number
}

/** Version-control state of one architecture file in the primary worktree, relative to its committed version. */
export type GitFileStatus = 'committed' | 'modified' | 'untracked' | 'ignored'

/** One file under the local architecture directory. */
export interface LocalEntry {
  /** Repository-relative path. */
  readonly path: string
  /** Version-control state in the primary worktree. */
  readonly status: GitFileStatus
}

/** Everything the dashboard shows for one repository, read at one moment. */
export interface ArchitectureSnapshot {
  /** Canonical primary-worktree root. */
  readonly root: string
  /** Version-control system of the repository; absent when `unsupported` is set. */
  readonly vcs?: VcsKind
  /** Why the directory has no architecture state: it is outside git and jj, or its system's executable is missing. */
  readonly unsupported?: { readonly kind: 'no-repository' } | { readonly kind: 'vcs-missing'; readonly vcs: VcsKind }
  /** The repository's main branch, from its manifest or the service default; absent when neither names one. */
  readonly mainBranch?: string
  /** Configured manifest path, relative to the repository root. */
  readonly manifestPath: string
  /** Configured local architecture directory, relative to the repository root. */
  readonly localDirectory: string
  /** Whether the repository has a manifest. */
  readonly hasManifest: boolean
  /** Current index revision; changes whenever indexed content changes. */
  readonly revision: string
  /** The index, empty without a manifest. */
  readonly index: ArchitectureIndex
  /** The repository's local branches or jj bookmarks, which `setMainBranch` may declare; absent when `unsupported` is set. */
  readonly branches?: {
    /** Every local branch or bookmark, sorted. */
    readonly all: readonly string[]
    /** The ones the primary checkout is on: git's `HEAD` branch, or jj bookmarks at `@` or `@-`. */
    readonly current: readonly string[]
  }
  /** Version-control state of each indexed source. */
  readonly sourceStatus: Readonly<Record<string, GitFileStatus>>
  /** Recorded Rulings, newest first, each with whether a cited section changed since issue. */
  readonly rulings: ReadonlyArray<RulingRecord & { readonly stale: boolean }>
  /** Appeals, pending first, then newest first. */
  readonly appeals: readonly AppealRecord[]
  /** Accepted sections. */
  readonly acceptances: readonly Acceptance[]
  /** Files under the local directory other than records this service writes. */
  readonly localEntries: readonly LocalEntry[]
  /** Record files that could not be read, with the local-directory path and the reason. */
  readonly problems: ReadonlyArray<{ readonly file: string; readonly message: string }>
  /**
   * True when just read; false for the copy {@link ArchitectureService.lastSnapshot} returns, which may predate
   * changes written since, so its Rulings, appeals, and proposed edits may already be decided.
   */
  readonly fresh: boolean
}
