/** Real-jj helpers for tests; jj suites skip on a host without jj. */
import { execFileSync } from 'node:child_process'

/** Environment that makes jj ignore user configuration and sign commits as a fixed identity. */
export const JJ_ENV = { ...process.env, JJ_CONFIG: '/dev/null', JJ_USER: 't', JJ_EMAIL: 't@example.com' }

/**
 * Whether a jj executable is on PATH.
 * @returns true when `jj --version` runs.
 */
export function hasJj(): boolean {
  try {
    execFileSync('jj', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    // execFileSync failed: jj is not installed on this host, so the real-jj suites skip.
    return false
  }
}

/**
 * Run jj in a directory and return its standard output.
 * @param cwd - working directory.
 * @param args - jj arguments.
 * @returns standard output.
 */
export function jj(cwd: string, ...args: string[]): string {
  return execFileSync('jj', [...args, '--no-pager', '--color=never'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: JJ_ENV })
}
