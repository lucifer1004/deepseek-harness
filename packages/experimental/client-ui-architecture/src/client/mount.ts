/** Source-safe lifecycle for the architecture Remote contribution and dashboard page. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/remote'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-experimental-api-architecture/remote'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { ArchitecturePage, type ArchitecturePageInjected, type WorkspaceChoice } from './ArchitecturePage.tsx'
import { ArchitectureIcon } from './ArchitectureIcon.tsx'
import { createDashboardSource } from './dashboard-source.ts'
import { en, NS, zh, type ArchitectureKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Architecture dashboard copy. */
    'architecture': ArchitectureKey
  }
}

/** Agent preset an Architecture Session runs. */
export const ARCHITECT_PRESET = 'architect'

const PANEL_ID = 'architecture' as MainPanelId

/** Required browser services. */
export const inject = ['remote', 'slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace', 'layout']

/**
 * Derive the Workspace choices from the Workspace list, keeping one array
 * identity while the rows are unchanged.
 * @param ctx - Client Context with `workspaces`.
 * @returns the observable choices.
 */
function workspaceChoices(ctx: Context): HostObservable<readonly WorkspaceChoice[]> {
  let source: unknown
  let choices: readonly WorkspaceChoice[] = []
  return {
    getSnapshot() {
      const snapshot = ctx.workspaces.list.getSnapshot()
      if (snapshot.items !== source) {
        source = snapshot.items
        choices = snapshot.items.map(item => ({ workspaceId: item.workspaceId, title: item.title }))
      }
      return choices
    },
    subscribe: listener => ctx.workspaces.list.subscribe(listener),
  }
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-architecture: dictionaries')
  const t = ctx.locale.bind(NS)
  const dashboard = createDashboardSource(ctx)
  ctx.effect(() => () => dashboard.dispose(), 'client-ui-architecture: dashboard stream')
  const workspaces = workspaceChoices(ctx)
  // Follow the first Workspace until the user picks one.
  const pickFirst = (): void => {
    const [first] = workspaces.getSnapshot()
    if (dashboard.state.getSnapshot().workspaceId === null && first !== undefined) dashboard.select(first.workspaceId)
  }
  ctx.effect(() => workspaces.subscribe(pickFirst), 'client-ui-architecture: default workspace')
  pickFirst()
  const injected: ArchitecturePageInjected = {
    hooks: { architectureDashboard: dashboard.state, architectureWorkspaces: workspaces },
    selectWorkspace: (workspaceId) => { dashboard.select(workspaceId) },
    discuss: async (workspaceId) => {
      let sessionId
      try {
        sessionId = await ctx.sessions.create({ workspaceId })
      } catch (error) {
        console.warn('architecture: creating an Architecture Session failed:', error)
        return false
      }
      const selected = await ctx.remote.agentPresets.select(sessionId, ARCHITECT_PRESET)
      if (!selected.ok) return false
      ctx.uiWorkspace.openSession(sessionId)
      return true
    },
    readSection: async (workspaceId, path, anchor) => {
      const result = await ctx.remote.architecture.section({ workspaceId, path, anchor })
      return result.ok ? result.value : undefined
    },
    accept: async (workspaceId, section) => {
      const result = await ctx.remote.architecture.accept({ workspaceId, path: section.path, anchor: section.anchor, hash: section.hash })
      return result.ok
    },
    adjudicate: async (workspaceId, appealId, adjudication) => {
      const result = await ctx.remote.architecture.adjudicate({ workspaceId, appealId, adjudication })
      return result.ok
    },
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => injected,
  }, ArchitecturePage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 20,
    locale: NS,
    label: () => t('panel'),
  }, ArchitectureIcon))
}

/**
 * Mount the architecture Remote contribution, then the dashboard.
 * @param ctx - Client runtime.
 * @param contribution - generated architecture Remote contribution.
 * @returns complete UI and Remote disposer.
 */
export async function mountArchitecture(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.architecture', 'remote.agentPresets', 'slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
