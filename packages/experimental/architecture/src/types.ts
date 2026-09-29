/** Public types of the workspace architecture sources, section index, and edit rule. */

import type { Branded } from '@deepseek-ai/dsh-brand'

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
}

/** Workspace-relative POSIX path of one architecture source file. */
export type SourcePath = Branded<'ArchitectureSourcePath'>

/** Lowercase hexadecimal SHA-256 of one section's normalized content. */
export type SectionHash = Branded<'ArchitectureSectionHash'>

/** Validated contents of the architecture manifest. */
export interface ArchitectureManifest {
  /** Workspace-relative POSIX globs naming the authoritative source documents. */
  readonly sources: readonly string[]
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

/** One validated write of a whole architecture file. */
export interface ArchitectureEditRequest {
  /** Workspace directory of the requesting Session; resolves `path` and locates the checkout. */
  readonly cwd: string
  /** Target file, relative to the repository root or absolute inside it. */
  readonly path: string
  /** Complete new UTF-8 content of the file. */
  readonly content: string
  /** Cancels the write and the index rebuild. */
  readonly signal?: AbortSignal | undefined
}

/** Outcome of {@link ArchitectureEditRequest}. */
export type ArchitectureEditResult =
  | { readonly kind: 'written'; readonly path: string }
  | { readonly kind: 'refused'; readonly refusal: EditRefusal }
