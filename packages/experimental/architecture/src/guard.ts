/**
 * Classify tool calls against the architecture edit rule. The tool guard is
 * synchronous, so it resolves paths with local synchronous path resolution and
 * matches them against the protected-path set computed from the latest index.
 * @module @deepseek-ai/dsh-experimental-architecture/guard
 */

import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { matchSources } from './index-builder.ts'
import type { ArchitectureManifest } from './types.ts'

/** Built-in tools whose arguments name one file they write. */
const PATH_ARGUMENT: Readonly<Record<string, string>> = {
  write: 'file_path',
  edit: 'file_path',
  str_replace_editor: 'path',
}

/** `str_replace_editor` commands that do not write. */
const READ_ONLY_EDITOR_COMMANDS = new Set(['view'])

/**
 * Canonicalize a path whose final components may not exist yet: resolve the
 * longest existing ancestor through symlinks and append the remainder.
 * @param path - absolute path.
 * @returns the canonical spelling a later write would reach.
 */
export function canonicalizeForWrite(path: string): string {
  // Walk up to an existing ancestor; the filesystem root always resolves.
  let existing = path
  const rest: string[] = []
  for (;;) {
    try {
      const real = realpathSync.native(existing)
      return rest.length === 0 ? real : join(real, ...rest.reverse())
    } catch {
      // realpathSync.native failed: this component does not exist yet, so resolve its parent.
      rest.push(basename(existing))
      existing = dirname(existing)
    }
  }
}

/** The parts of a tool execution the write-target resolution reads. */
export interface WriteCall {
  /** Registered tool name. */
  readonly name: string
  /** Model-supplied arguments, not yet validated against the tool schema. */
  readonly arguments: unknown
  /** Working directory of the calling Session, when the call has one. */
  readonly cwd: string | undefined
}

/**
 * The parts of a tool execution {@link writeTarget} reads.
 * @param exec - the tool execution.
 * @returns the tool name, arguments, and Session working directory.
 */
export function writeCall(exec: Readonly<ToolExecution>): WriteCall {
  return { name: exec.name, arguments: exec.arguments, cwd: exec.agent?.session.header.cwd }
}

/**
 * The file a mutating built-in tool call writes, resolved against the calling
 * Session's working directory.
 * @param call - tool name, arguments, and Session working directory.
 * @returns the absolute target path, or undefined when the call does not write a named file.
 */
export function writeTarget(call: WriteCall): string | undefined {
  const field = PATH_ARGUMENT[call.name]
  if (field === undefined) return undefined
  const args = call.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Readonly<Record<string, unknown>>
  if (call.name === 'str_replace_editor' && typeof record.command === 'string' && READ_ONLY_EDITOR_COMMANDS.has(record.command)) {
    return undefined
  }
  const value = record[field]
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  if (isAbsolute(value)) return value
  return call.cwd === undefined ? undefined : resolve(call.cwd, value)
}

/** Paths the edit rule protects in one repository. */
export interface ProtectedPaths {
  /** Canonical repository root. */
  readonly root: string
  /** Canonical absolute paths of manifest sources and the manifest itself. */
  readonly files: ReadonlySet<string>
  /** Canonical absolute path of the local architecture directory. */
  readonly localDirectory: string
  /** Source and exclude globs; a path they match is protected before it exists or is indexed. */
  readonly sources?: Pick<ArchitectureManifest, 'sources' | 'exclude'> | undefined
}

/**
 * Whether an absolute, canonical path is protected.
 * @param target - canonical absolute path.
 * @param paths - protected paths of one repository.
 * @returns true for a manifest source, a path its globs match, the manifest, or a path under the local directory.
 */
export function isProtected(target: string, paths: ProtectedPaths): boolean {
  if (paths.files.has(target)) return true
  if (inside(paths.localDirectory, target) !== undefined) return true
  const path = inside(paths.root, target)
  return paths.sources !== undefined && path !== undefined && path !== '' && matchSources([path.split(sep).join(posix.sep)], paths.sources).length > 0
}

/** The path of `target` relative to `root`, or undefined when it lies outside. */
function inside(root: string, target: string): string | undefined {
  const path = relative(root, target)
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path) ? undefined : path
}
