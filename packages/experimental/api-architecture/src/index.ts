/**
 * Client access to the architecture dashboard state of a Workspace: a snapshot,
 * a stream of snapshots that follows every change, section text, acceptance,
 * and appeal decisions. Calls never activate or submit to an Agent, except that
 * a decision is delivered to a live worker Session as its next input.
 * @module @deepseek-ai/dsh-experimental-api-architecture
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { describeRefusal } from '@deepseek-ai/dsh-experimental-architecture'
import type { Acceptance, AppealRecord, ArchitectureEditResult, ArchitectureSnapshot } from '@deepseek-ai/dsh-experimental-architecture/types'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {
  ArchitectureAcceptRequest,
  ArchitectureAdjudicateRequest,
  ArchitectureMainBranchRequest,
  ArchitectureSectionRequest,
  ArchitectureSectionValue,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Experimental architecture Remote controller. */
    architectureController: ArchitectureController
  }
}

/**
 * Wrap a service failure as a Remote failure the Client can display.
 * @param error - the thrown value.
 * @returns the Remote error.
 */
function failed(error: unknown): RemoteError {
  const reason = error instanceof Error ? error.message : String(error)
  return new RemoteError('architecture/failed', reason, { reason })
}

/**
 * Read an abort signal's current state after an await.
 * @param signal - the signal.
 * @returns whether it is aborted now.
 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** The `architecture` Remote namespace over `ctx.architecture`, addressed by Workspace. */
export default class ArchitectureController extends TypertRemoteService {
  static inject = ['architecture', 'workspaceRegistry', 'typert']

  constructor(ctx: Context) {
    super(ctx, 'architectureController', { namespace: 'architecture' })
  }

  /**
   * Read the dashboard state of a Workspace, rebuilding its index.
   * @param workspaceId - Workspace whose repository is shown.
   * @param signal - Client cancellation.
   * @returns the complete snapshot.
   */
  @Remote
  async snapshot(workspaceId: WorkspaceId, signal: AbortSignal): Promise<ArchitectureSnapshot> {
    const path = this.workspacePath(workspaceId)
    try {
      return await this.ctx.architecture.snapshot(path, signal)
    } catch (error) {
      signal.throwIfAborted()
      throw failed(error)
    }
  }

  /**
   * Follow the dashboard state of a Workspace: yield a snapshot now and after
   * each `architecture/changed` notification for its repository. Notifications
   * that arrive while a snapshot is being read coalesce into one more read.
   * @param workspaceId - Workspace whose repository is shown.
   * @param signal - Client observation lifetime.
   * @returns complete snapshots, oldest first.
   */
  @Remote({ mode: 'stream' })
  async *follow(workspaceId: WorkspaceId, signal: AbortSignal): AsyncIterable<ArchitectureSnapshot> {
    const path = this.workspacePath(workspaceId)
    let root: string | undefined
    let dirty = true
    let wake: (() => void) | undefined
    const stop = this.ctx.on('architecture/changed', (changed) => {
      if (root !== undefined && changed !== root) return
      dirty = true
      wake?.()
    })
    const onAbort = (): void => { wake?.() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!signal.aborted) {
        if (!dirty) {
          await new Promise<void>((resolve) => { wake = resolve })
          wake = undefined
          continue
        }
        dirty = false
        let snapshot: ArchitectureSnapshot
        try {
          snapshot = await this.ctx.architecture.snapshot(path, signal)
        } catch (error) {
          if (isAborted(signal)) return
          throw failed(error)
        }
        root = snapshot.root
        yield snapshot
      }
    } finally {
      stop()
      signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Read one indexed section's text from the primary worktree.
   * @param request - Workspace, path, and anchor.
   * @param signal - Client cancellation.
   * @returns the section's hash and text.
   */
  @Remote
  async section(request: ArchitectureSectionRequest, signal: AbortSignal): Promise<ArchitectureSectionValue> {
    const path = this.workspacePath(request.workspaceId)
    let found: Awaited<ReturnType<Context['architecture']['readSection']>>
    try {
      // The dashboard lists sections from the snapshot the service last built, so the section is read against
      // that index; only a Workspace with no index yet pays for a rebuild.
      if (this.ctx.architecture.index(path) === undefined) await this.ctx.architecture.rebuild(path, signal)
      found = await this.ctx.architecture.readSection(path, request.path, request.anchor, signal)
    } catch (error) {
      signal.throwIfAborted()
      throw failed(error)
    }
    if (found === undefined) throw failed(new Error(`${request.path}#${request.anchor} is not an indexed section`))
    return { path: found.section.path, anchor: found.section.anchor, hash: found.section.hash, text: found.text }
  }

  /**
   * Accept a section's reviewed content so Rulings may cite it before it is committed.
   * @param request - Workspace, section, and the reviewed hash.
   * @returns the recorded acceptance.
   */
  @Remote
  async accept(request: ArchitectureAcceptRequest): Promise<Acceptance> {
    const path = this.workspacePath(request.workspaceId)
    try {
      return await this.ctx.architecture.accept(path, request.path, request.anchor, request.hash)
    } catch (error) {
      throw failed(error)
    }
  }

  /**
   * Declare the repository's main branch in its manifest, under the main-branch edit rule.
   * @param request - Workspace and branch.
   * @param signal - Client cancellation.
   * @returns the written manifest path.
   * @throws `architecture/failed` naming the refusal when the rule is not met, or the manifest is missing or invalid.
   */
  @Remote
  async setMainBranch(request: ArchitectureMainBranchRequest, signal: AbortSignal): Promise<{ readonly path: string }> {
    const path = this.workspacePath(request.workspaceId)
    let result: ArchitectureEditResult
    try {
      result = await this.ctx.architecture.setMainBranch(path, request.branch, signal)
    } catch (error) {
      signal.throwIfAborted()
      throw failed(error)
    }
    signal.throwIfAborted()
    if (result.kind === 'refused') throw failed(new Error(describeRefusal(result.refusal)))
    return { path: result.path }
  }

  /**
   * Decide a pending appeal and deliver the decision to the worker Session.
   * @param request - Workspace, appeal, and decision.
   * @returns the decided appeal.
   */
  @Remote
  async adjudicate(request: ArchitectureAdjudicateRequest): Promise<AppealRecord> {
    const path = this.workspacePath(request.workspaceId)
    try {
      return await this.ctx.architecture.adjudicate(path, request.appealId, request.adjudication)
    } catch (error) {
      throw failed(error)
    }
  }

  private workspacePath(workspaceId: WorkspaceId): string {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) {
      throw new RemoteError('architecture/workspace-not-found', `workspace "${workspaceId}" not found`, { workspaceId })
    }
    return workspace.path
  }
}
