/**
 * Run bounded git queries for one checkout: list candidate architecture files
 * and read a file as committed on a branch. Git runs through the subprocess
 * capability with a scrubbed environment, a timeout, and bounded output.
 * @module @deepseek-ai/dsh-experimental-architecture/git-files
 */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Milliseconds a git child gets to exit after termination starts. */
const TERMINATE_GRACE_MS = 2_000
/** Byte cap on retained git stderr. */
const STDERR_MAX_BYTES = 16 * 1024

/** Bounds every git command runs under. */
export interface GitLimits {
  /** Milliseconds before a command is terminated. */
  readonly timeoutMs: number
  /** Byte cap on collected stdout; output above it fails instead of truncating. */
  readonly outputMaxBytes: number
}

/** Git state of a path that differs from its committed version. */
export type ChangedStatus = 'modified' | 'untracked' | 'ignored'

/** Runs git queries for one checkout. */
export class GitFiles {
  /**
   * @param subprocess - process capability used to spawn git.
   * @param executable - resolved git executable.
   * @param limits - timeout and output cap.
   */
  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly executable: string,
    private readonly limits: GitLimits,
  ) {}

  private async run(
    args: readonly string[],
    root: string,
    signal: AbortSignal | undefined,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const timeout = AbortSignal.timeout(this.limits.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const handle = this.subprocess.spawn({
      argv: [this.executable, ...args],
      cwd: root,
      stdio: { stdin: 'ignore', stdout: { maxBytes: this.limits.outputMaxBytes }, stderr: { maxBytes: STDERR_MAX_BYTES } },
      graceMs: TERMINATE_GRACE_MS,
      signal: combined,
      env: { GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    })
    const outcome = await handle.done
    const command = `git ${args[0]}`
    if (combined.aborted) {
      throw new Error(`${command} ${timeout.aborted ? `timed out after ${this.limits.timeoutMs}ms` : 'was aborted'}`)
    }
    /* v8 ignore start -- collect-mode stdio always yields both readers. */
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    /* v8 ignore stop */
    if (stdout.lossy) throw new Error(`${command} output exceeded ${this.limits.outputMaxBytes} bytes in ${root}`)
    return { code: outcome.exitCode, stdout: stdout.text, stderr }
  }

  /**
   * List candidate files of a checkout: tracked files plus untracked files that
   * are not ignored, limited to the given globs. Git applies the globs as
   * `:(glob)` pathspecs, so the listing holds only candidate sources; the caller
   * still matches them against the manifest.
   * @param root - checkout root.
   * @param globs - repository-relative POSIX globs.
   * @param signal - cancels the listing.
   * @returns repository-relative POSIX paths.
   * @throws when git fails, times out, is aborted, prints more than the output cap, or ends mid-entry.
   */
  async list(root: string, globs: readonly string[], signal: AbortSignal | undefined): Promise<readonly string[]> {
    const pathspecs = globs.map(glob => `:(glob)${glob}`)
    const result = await this.run(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs], root, signal)
    if (result.code !== 0) throw new Error(`git ls-files failed in ${root}: ${result.stderr.trim()}`)
    // Every entry ends in NUL, so complete output is empty or ends in NUL.
    if (result.stdout.length > 0 && !result.stdout.endsWith('\0')) throw new Error(`git ls-files output ended mid-entry in ${root}`)
    return [...new Set(result.stdout.split('\0').filter(path => path.length > 0))]
  }

  /**
   * Read one file as committed at the tip of a branch.
   * @param root - checkout root.
   * @param branch - local branch name.
   * @param path - repository-relative POSIX path.
   * @param signal - cancels the read.
   * @returns the committed UTF-8 text, or undefined when the branch or the path at its tip does not exist.
   * @throws when git fails for another reason, times out, is aborted, or prints more than the output cap.
   */
  async committed(root: string, branch: string, path: string, signal: AbortSignal | undefined): Promise<string | undefined> {
    const result = await this.run(['cat-file', 'blob', `refs/heads/${branch}:${path}`], root, signal)
    if (result.code === 0) return result.stdout
    // A missing branch is an invalid object name; a path absent from the ref either "does not exist in" it
    // or, when a file of that name is in the work tree, "exists on disk, but not in" it.
    if (/invalid object name|does not exist in|exists on disk, but not in/.test(result.stderr)) return undefined
    throw new Error(`git cat-file failed in ${root}: ${result.stderr.trim()}`)
  }

  /**
   * Report the git state of paths under the given pathspecs, including ignored
   * and untracked files. A path absent from the report and present on disk is
   * committed and unmodified.
   * @param root - checkout root.
   * @param paths - repository-relative POSIX paths or directories.
   * @param signal - cancels the command.
   * @returns the state of every reported path.
   * @throws when git fails, times out, is aborted, prints more than the output cap, or ends mid-entry.
   */
  async status(root: string, paths: readonly string[], signal: AbortSignal | undefined): Promise<ReadonlyMap<string, ChangedStatus>> {
    const states = new Map<string, ChangedStatus>()
    if (paths.length === 0) return states
    const result = await this.run([
      'status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--no-renames', '--', ...paths.map(path => `:(literal)${path}`),
    ], root, signal)
    if (result.code !== 0) throw new Error(`git status failed in ${root}: ${result.stderr.trim()}`)
    if (result.stdout.length > 0 && !result.stdout.endsWith('\0')) throw new Error(`git status output ended mid-entry in ${root}`)
    for (const entry of result.stdout.split('\0')) {
      if (entry === '') continue
      const code = entry.slice(0, 2)
      states.set(entry.slice(3), code === '??' ? 'untracked' : code === '!!' ? 'ignored' : 'modified')
    }
    return states
  }
}
