/**
 * Git queries for one repository: list candidate architecture files, read a
 * file as committed on a branch, and report uncommitted files. Reads pass
 * `GIT_OPTIONAL_LOCKS=0`, so they never write `.git`.
 * @module @deepseek-ai/dsh-experimental-architecture/git-files
 */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { CheckoutState } from './types.ts'
import { CommandRunner, nulEntries, type BranchList, type ChangedStatus, type VcsFiles, type VcsLimits } from './vcs.ts'

/** Git implementation of {@link VcsFiles}. */
export class GitFiles implements VcsFiles {
  private readonly git: CommandRunner

  /**
   * @param subprocess - process capability used to spawn git.
   * @param executable - resolved git executable.
   * @param limits - timeout and output cap.
   */
  constructor(subprocess: SubprocessRuntime, executable: string, limits: VcsLimits) {
    this.git = new CommandRunner(subprocess, executable, 'git', {
      GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C',
    }, limits)
  }

  /**
   * List tracked files plus untracked files that are not ignored. The globs are `:(glob)` pathspecs.
   * @param root - checkout root.
   * @param globs - repository-relative POSIX globs.
   * @param signal - cancels the listing.
   * @returns repository-relative POSIX paths.
   * @throws when git fails, times out, is aborted, prints more than the output cap, or ends mid-entry.
   */
  async list(root: string, globs: readonly string[], signal: AbortSignal | undefined): Promise<readonly string[]> {
    const pathspecs = globs.map(glob => `:(glob)${glob}`)
    const result = await this.git.run(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs], root, signal)
    if (result.code !== 0) throw new Error(`git ls-files failed in ${root}: ${result.stderr.trim()}`)
    return [...new Set(nulEntries(result.stdout, 'git ls-files', root))]
  }

  /**
   * Read one file at the tip of `refs/heads/<branch>`.
   * @param root - checkout root.
   * @param branch - local branch name.
   * @param path - repository-relative POSIX path.
   * @param signal - cancels the read.
   * @returns the committed UTF-8 text, or undefined when the branch or the path at its tip does not exist.
   * @throws when git fails for another reason, times out, is aborted, or prints more than the output cap.
   */
  async committed(root: string, branch: string, path: string, signal: AbortSignal | undefined): Promise<string | undefined> {
    const result = await this.git.run(['cat-file', 'blob', `refs/heads/${branch}:${path}`], root, signal)
    if (result.code === 0) return result.stdout
    // A missing branch is an invalid object name; a path absent from the ref either "does not exist in" it
    // or, when a file of that name is in the work tree, "exists on disk, but not in" it.
    if (/invalid object name|does not exist in|exists on disk, but not in/.test(result.stderr)) return undefined
    throw new Error(`git cat-file failed in ${root}: ${result.stderr.trim()}`)
  }

  /**
   * Report the state of paths relative to the index and `HEAD`, including ignored and untracked files.
   * @param root - checkout root.
   * @param _branch - unused: git reports changes against `HEAD`, the commit the checkout will extend.
   * @param paths - repository-relative POSIX paths.
   * @param signal - cancels the command.
   * @returns the state of every reported path.
   * @throws when git fails, times out, is aborted, prints more than the output cap, or ends mid-entry.
   */
  async status(
    root: string,
    _branch: string | undefined,
    paths: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<ReadonlyMap<string, ChangedStatus>> {
    if (paths.length === 0) return new Map()
    return this.statusOf(root, ['--ignored=matching', '--untracked-files=all'], paths.map(path => `:(literal)${path}`), signal)
  }

  private async statusOf(
    root: string,
    options: readonly string[],
    pathspecs: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<ReadonlyMap<string, ChangedStatus>> {
    const states = new Map<string, ChangedStatus>()
    const result = await this.git.run(['status', '--porcelain=v1', '-z', ...options, '--no-renames', '--', ...pathspecs], root, signal)
    if (result.code !== 0) throw new Error(`git status failed in ${root}: ${result.stderr.trim()}`)
    for (const entry of nulEntries(result.stdout, 'git status', root)) {
      const code = entry.slice(0, 2)
      states.set(entry.slice(3), code === '??' ? 'untracked' : code === '!!' ? 'ignored' : 'modified')
    }
    return states
  }

  /**
   * Report changed files under the globs with one `git status`. Without `--ignored`, an ignored file is never reported,
   * as `ls-files --exclude-standard` never lists one.
   * @param root - checkout root.
   * @param _branch - unused: git compares with the checkout's `HEAD`.
   * @param globs - repository-relative POSIX globs, as `:(glob)` pathspecs.
   * @param signal - cancels the query.
   * @returns the state of every reported path.
   * @throws when git fails, times out, is aborted, prints more than the output cap, or ends mid-entry.
   */
  async globStatus(
    root: string,
    _branch: string | undefined,
    globs: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<ReadonlyMap<string, ChangedStatus>> {
    return this.statusOf(root, ['--untracked-files=all'], globs.map(glob => `:(glob)${glob}`), signal)
  }

  /**
   * List `refs/heads`, and the branch `HEAD` names as the current one.
   * @param checkout - the checkout; `HEAD` is read from its `.git` metadata.
   * @param signal - cancels the listing.
   * @returns every local branch, and `HEAD`'s branch unless `HEAD` is detached.
   * @throws when git fails, times out, is aborted, prints more than the output cap, or ends mid-entry.
   */
  async branches(checkout: CheckoutState, signal: AbortSignal | undefined): Promise<BranchList> {
    const result = await this.git.run(['for-each-ref', '--format=%(refname:lstrip=2)%00', 'refs/heads/'], checkout.root, signal)
    if (result.code !== 0) throw new Error(`git for-each-ref failed in ${checkout.root}: ${result.stderr.trim()}`)
    // for-each-ref ends each record with a newline after the format's NUL.
    const all = [...new Set(nulEntries(result.stdout.replaceAll('\0\n', '\0'), 'git for-each-ref', checkout.root))].sort()
    return { all, current: checkout.branch === undefined ? [] : [checkout.branch] }
  }
}
