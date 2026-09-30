/**
 * The version-control queries the architecture service runs, and the bounded
 * command runner both adapters share. Every command runs through the
 * subprocess capability with an explicit environment, a timeout, and an
 * output cap above which it fails instead of truncating.
 * @module @deepseek-ai/dsh-experimental-architecture/vcs
 */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { CheckoutState } from './types.ts'

/** Milliseconds a child gets to exit after termination starts. */
const TERMINATE_GRACE_MS = 2_000
/** Byte cap on retained stderr. */
const STDERR_MAX_BYTES = 16 * 1024

/** Bounds every version-control command runs under. */
export interface VcsLimits {
  /** Milliseconds before a command is terminated. */
  readonly timeoutMs: number
  /** Byte cap on collected stdout; output above it fails instead of truncating. */
  readonly outputMaxBytes: number
}

/** State of an existing file that differs from its committed version. */
export type ChangedStatus = 'modified' | 'untracked' | 'ignored'

/** Queries one version-control system answers for a repository. */
export interface VcsFiles {
  /**
   * List candidate files: tracked files plus new files the VCS does not ignore, limited to the given globs. The
   * caller still matches them against the manifest.
   * @param root - primary checkout root.
   * @param globs - repository-relative POSIX globs.
   * @param signal - cancels the listing.
   * @returns repository-relative POSIX paths.
   */
  list(root: string, globs: readonly string[], signal: AbortSignal | undefined): Promise<readonly string[]>
  /**
   * Read one file as committed at the tip of the main branch.
   * @param root - primary checkout root.
   * @param branch - git branch or jj bookmark name.
   * @param path - repository-relative POSIX path.
   * @param signal - cancels the read.
   * @returns the committed UTF-8 text, or undefined when the branch or the path at its tip does not exist.
   */
  committed(root: string, branch: string, path: string, signal: AbortSignal | undefined): Promise<string | undefined>
  /**
   * Report existing files whose content is not the committed version.
   * @param root - primary checkout root.
   * @param branch - main branch; jj compares with it, git with the checkout's `HEAD`.
   * @param paths - repository-relative POSIX paths of existing files.
   * @param signal - cancels the query.
   * @returns the state of every reported path; an absent path is committed and unmodified.
   */
  status(
    root: string,
    branch: string | undefined,
    paths: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<ReadonlyMap<string, ChangedStatus>>
  /**
   * Whether a checkout is on the main branch, where architecture sources may change.
   * @param checkout - the checkout.
   * @param branch - git branch or jj bookmark name.
   * @param signal - cancels the query.
   * @returns true on the branch.
   */
  onBranch(checkout: CheckoutState, branch: string, signal: AbortSignal | undefined): Promise<boolean>
  /**
   * The branches a checkout is on: names that {@link onBranch} accepts for it.
   * @param checkout - the checkout.
   * @param signal - cancels the query.
   * @returns branch or bookmark names, sorted; empty on a detached `HEAD` or without a bookmark at `@` or `@-`.
   */
  currentBranches(checkout: CheckoutState, signal: AbortSignal | undefined): Promise<readonly string[]>
}

/** One finished command. */
export interface CommandOutcome {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Runs one executable with fixed limits and environment. */
export class CommandRunner {
  /**
   * @param subprocess - process capability used to spawn the executable.
   * @param executable - resolved executable path.
   * @param label - command name used in diagnostics.
   * @param env - explicit environment entries layered onto the provider's scrubbed base.
   * @param limits - timeout and output cap.
   */
  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly executable: string,
    private readonly label: string,
    private readonly env: Readonly<Record<string, string>>,
    private readonly limits: VcsLimits,
  ) {}

  /**
   * Run one command to completion.
   * @param args - arguments after the executable; the first names the command in diagnostics.
   * @param cwd - working directory.
   * @param signal - cancels the command.
   * @returns exit code and complete output.
   * @throws when the command times out, is aborted, or prints more than the output cap.
   */
  async run(args: readonly string[], cwd: string, signal: AbortSignal | undefined): Promise<CommandOutcome> {
    const timeout = AbortSignal.timeout(this.limits.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const handle = this.subprocess.spawn({
      argv: [this.executable, ...args],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: this.limits.outputMaxBytes }, stderr: { maxBytes: STDERR_MAX_BYTES } },
      graceMs: TERMINATE_GRACE_MS,
      signal: combined,
      env: { ...this.env },
    })
    const outcome = await handle.done
    const command = `${this.label} ${args[0]}`
    if (combined.aborted) {
      throw new Error(`${command} ${timeout.aborted ? `timed out after ${this.limits.timeoutMs}ms` : 'was aborted'}`)
    }
    /* v8 ignore start -- collect-mode stdio always yields both readers. */
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    /* v8 ignore stop */
    if (stdout.lossy) throw new Error(`${command} output exceeded ${this.limits.outputMaxBytes} bytes in ${cwd}`)
    return { code: outcome.exitCode, stdout: stdout.text, stderr }
  }
}

/**
 * Split NUL-terminated output into entries.
 * @param output - complete stdout.
 * @param command - command name used in the error.
 * @param root - working directory used in the error.
 * @returns the non-empty entries.
 * @throws when the output does not end in NUL, so the last entry was cut off.
 */
export function nulEntries(output: string, command: string, root: string): string[] {
  if (output.length > 0 && !output.endsWith('\0')) throw new Error(`${command} output ended mid-entry in ${root}`)
  return output.split('\0').filter(entry => entry.length > 0)
}
