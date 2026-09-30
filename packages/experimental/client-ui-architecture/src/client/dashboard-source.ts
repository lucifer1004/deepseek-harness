/** One reconnecting mirror of the selected Workspace's architecture snapshot. */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ArchitectureSnapshot } from '@deepseek-ai/dsh-experimental-api-architecture/types'
import type {} from '@deepseek-ai/dsh-experimental-api-architecture/remote'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Dashboard state for one selected Workspace. */
export interface DashboardState {
  /** Workspace the snapshot belongs to; null before the user picks one. */
  readonly workspaceId: WorkspaceId | null
  /** Latest snapshot of that Workspace, null until the first arrives. */
  readonly snapshot: ArchitectureSnapshot | null
  /** Latest read or transport failure; a later snapshot clears it. */
  readonly error: string | null
}

/** The dashboard mirror and its Workspace selection. */
export interface DashboardSource {
  readonly state: SnapshotStore<DashboardState>
  /**
   * Follow another Workspace; the previous stream closes first.
   * @param workspaceId - Workspace to follow, or null to stop following.
   */
  select(workspaceId: WorkspaceId | null): void
  /** Close the current stream. */
  dispose(): Promise<void>
}

/**
 * Create the mirror. It follows at most one Workspace at a time.
 * @param ctx - Client Context with the mounted architecture Remote.
 * @returns the mirror.
 */
export function createDashboardSource(ctx: Context): DashboardSource {
  const state = createSnapshotStore<DashboardState>({ workspaceId: null, snapshot: null, error: null })
  let current: { readonly stop: () => Promise<void> } | undefined
  const follow = (workspaceId: WorkspaceId): { stop: () => Promise<void> } => {
    let stopped = false
    const fail = (error: unknown): void => {
      if (!stopped) state.set({ ...state.getSnapshot(), error: error instanceof Error ? error.message : String(error) })
    }
    const stream = ctx.remote.$stream<ArchitectureSnapshot>({
      name: 'Architecture dashboard',
      open: signal => ctx.remote.architecture.follow(workspaceId, signal),
      ended: () => new RemoteStreamCarrierError('Architecture dashboard stream ended'),
      carrierFailed: fail,
    })
    const observing = (async () => {
      try {
        // A stopped stream is disposed, so it yields nothing after `stop`.
        for await (const item of stream) {
          state.set({ workspaceId, snapshot: item.value, error: null })
          item.accept()
        }
      } catch (error) { fail(error) }
    })()
    return { stop: async () => { stopped = true; await stream.dispose(); await observing } }
  }
  return {
    state,
    select(workspaceId) {
      if (workspaceId === state.getSnapshot().workspaceId) return
      const previous = current
      current = undefined
      void previous?.stop()
      state.set({ workspaceId, snapshot: null, error: null })
      if (workspaceId !== null) current = follow(workspaceId)
    },
    async dispose() {
      const previous = current
      current = undefined
      await previous?.stop()
    },
  }
}
