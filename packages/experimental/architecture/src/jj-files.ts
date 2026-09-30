/**
 * Jujutsu queries for one repository, colocated or not. Listing and status
 * snapshot the working copy, as every jj command does by default, so new
 * files appear the way `jj status` shows them; committed reads pass
 * `--ignore-working-copy`. The main branch is a local bookmark.
 * @module @deepseek-ai/dsh-experimental-architecture/jj-files
 */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { CheckoutState } from './types.ts'
import { CommandRunner, nulEntries, type ChangedStatus, type VcsFiles, type VcsLimits } from './vcs.ts'

/** Global options that keep output machine-readable whatever the user's jj configuration says. */
const GLOBAL_OPTIONS = ['--no-pager', '--color=never']

/**
 * Quote a value as a jj string literal.
 * @param value - raw text.
 * @returns the double-quoted literal with `\` and `"` escaped.
 */
export function jjString(value: string): string {
  return `"${value.replace(/[\\"]/g, match => `\\${match}`)}"`
}

/**
 * The revset naming one local bookmark exactly.
 * @param name - bookmark name.
 * @returns the revset.
 */
function bookmark(name: string): string {
  return `bookmarks(exact:${jjString(name)})`
}

/**
 * A fileset naming exactly the given repository-relative paths.
 * @param paths - repository-relative POSIX paths; at least one.
 * @returns the fileset expression.
 */
function exactFiles(paths: readonly string[]): string {
  return paths.map(path => `root-file:${jjString(path)}`).join(' | ')
}

/** Jujutsu implementation of {@link VcsFiles}. */
export class JjFiles implements VcsFiles {
  private readonly jj: CommandRunner

  /**
   * @param subprocess - process capability used to spawn jj.
   * @param executable - resolved jj executable.
   * @param limits - timeout and output cap.
   */
  constructor(subprocess: SubprocessRuntime, executable: string, limits: VcsLimits) {
    this.jj = new CommandRunner(subprocess, executable, 'jj', { LC_ALL: 'C' }, limits)
  }

  private async query(args: readonly string[], root: string, signal: AbortSignal | undefined): Promise<string> {
    const result = await this.jj.run([...args, ...GLOBAL_OPTIONS], root, signal)
    if (result.code !== 0) throw new Error(`jj ${args.slice(0, 2).join(' ')} failed in ${root}: ${result.stderr.trim()}`)
    return result.stdout
  }

  /**
   * List every file of the working-copy commit. jj tracks new files that it does not ignore when it snapshots, so the
   * listing holds tracked files and new unignored ones. The caller matches them against the manifest globs.
   * @param root - workspace root.
   * @param _globs - unused: jj glob syntax differs from the manifest's, so the caller matches every path.
   * @param signal - cancels the listing.
   * @returns repository-relative POSIX paths.
   * @throws when jj fails, times out, is aborted, prints more than the output cap, or ends mid-entry.
   */
  async list(root: string, _globs: readonly string[], signal: AbortSignal | undefined): Promise<readonly string[]> {
    const output = await this.query(['file', 'list', '-T', 'path ++ "\\0"'], root, signal)
    return [...new Set(nulEntries(output, 'jj file list', root))]
  }

  /**
   * Read one file at the commit a local bookmark points to.
   * @param root - workspace root.
   * @param branch - bookmark name.
   * @param path - repository-relative POSIX path.
   * @param signal - cancels the read.
   * @returns the committed UTF-8 text, or undefined when the bookmark does not exist or its commit lacks the path.
   * @throws when jj fails for another reason, such as a conflicted bookmark, times out, is aborted, or prints more than the output cap.
   */
  async committed(root: string, branch: string, path: string, signal: AbortSignal | undefined): Promise<string | undefined> {
    const args = ['file', 'show', '--ignore-working-copy', '-r', bookmark(branch), `root-file:${jjString(path)}`, ...GLOBAL_OPTIONS]
    const result = await this.jj.run(args, root, signal)
    if (result.code === 0) return result.stdout
    if (/didn't resolve to any revisions|No such path/.test(result.stderr)) return undefined
    throw new Error(`jj file show failed in ${root}: ${result.stderr.trim()}`)
  }

  /**
   * Compare existing files with the main bookmark's commit, or with the working-copy commit's parent when there is no
   * main branch or no such bookmark. A file jj does not track is ignored.
   * @param root - workspace root.
   * @param branch - main bookmark, or undefined.
   * @param paths - repository-relative POSIX paths of existing files.
   * @param signal - cancels the queries.
   * @returns the state of every reported path.
   * @throws when jj fails, times out, is aborted, prints more than the output cap, or ends mid-entry.
   */
  async status(
    root: string,
    branch: string | undefined,
    paths: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<ReadonlyMap<string, ChangedStatus>> {
    const states = new Map<string, ChangedStatus>()
    if (paths.length === 0) return states
    const fileset = exactFiles(paths)
    // Listing snapshots the working copy, so the diff below can skip it.
    const tracked = new Set(nulEntries(await this.query(['file', 'list', '-T', 'path ++ "\\0"', fileset], root, signal), 'jj file list', root))
    for (const path of paths) if (!tracked.has(path)) states.set(path, 'ignored')
    if (tracked.size === 0) return states
    // A missing bookmark compares with the working-copy commit's parent, as a repository without a main branch does.
    const from = branch === undefined ? '@-' : `coalesce(${bookmark(branch)}, @-)`
    const diff = await this.query(['diff', '--ignore-working-copy', '--from', from, '--to', '@', '-T', 'self.status() ++ "\\t" ++ self.path() ++ "\\0"', exactFiles([...tracked])], root, signal)
    for (const entry of nulEntries(diff, 'jj diff', root)) {
      const tab = entry.indexOf('\t')
      states.set(entry.slice(tab + 1), entry.slice(0, tab) === 'added' ? 'untracked' : 'modified')
    }
    return states
  }

  /**
   * Whether the workspace's working-copy commit is the bookmark's commit or a child of it, so its changes land on the
   * main branch when the bookmark moves forward.
   * @param checkout - the workspace.
   * @param branch - bookmark name.
   * @param signal - cancels the query.
   * @returns true when the bookmark points to `@` or `@-`.
   * @throws when jj fails, times out, is aborted, or prints more than the output cap.
   */
  async onBranch(checkout: CheckoutState, branch: string, signal: AbortSignal | undefined): Promise<boolean> {
    const output = await this.query(['log', '--ignore-working-copy', '--no-graph', '-r', `${bookmark(branch)} & (@ | @-)`, '-T', 'commit_id ++ "\\n"'], checkout.root, signal)
    return output.trim().length > 0
  }

  /**
   * The local bookmarks pointing to the working-copy commit or its parent.
   * @param checkout - the workspace.
   * @param signal - cancels the query.
   * @returns bookmark names, sorted.
   * @throws when jj fails, times out, is aborted, prints more than the output cap, or ends mid-entry.
   */
  async currentBranches(checkout: CheckoutState, signal: AbortSignal | undefined): Promise<readonly string[]> {
    const output = await this.query(['log', '--ignore-working-copy', '--no-graph', '-r', '@ | @-', '-T', 'local_bookmarks.map(|b| b.name() ++ "\\0").join("")'], checkout.root, signal)
    return [...new Set(nulEntries(output, 'jj log', checkout.root))].sort()
  }
}
