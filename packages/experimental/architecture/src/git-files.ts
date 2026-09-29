/**
 * List a checkout's candidate architecture files with git: tracked files plus
 * untracked files that are not ignored. Git runs through the subprocess
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
  /** Byte cap on collected stdout; a listing above it fails instead of truncating. */
  readonly outputMaxBytes: number
}

/** Runs `git ls-files` for one checkout. */
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

  /**
   * List candidate files of a checkout.
   * @param root - checkout root.
   * @param signal - cancels the listing.
   * @returns repository-relative POSIX paths.
   * @throws when git fails, times out, is aborted, or prints more than the output cap.
   */
  async list(root: string, signal: AbortSignal | undefined): Promise<readonly string[]> {
    const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
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
    if (combined.aborted) {
      throw new Error(`git ls-files ${timeout.aborted ? `timed out after ${this.limits.timeoutMs}ms` : 'was aborted'}`)
    }
    /* v8 ignore start -- collect-mode stdio always yields both readers. */
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    /* v8 ignore stop */
    if (outcome.exitCode !== 0) throw new Error(`git ls-files failed in ${root}: ${stderr.trim()}`)
    if (stdout.lossy) throw new Error(`git ls-files output exceeded ${this.limits.outputMaxBytes} bytes in ${root}`)
    return [...new Set(stdout.text.split('\0').filter(path => path.length > 0))]
  }
}
