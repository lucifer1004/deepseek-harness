// @vitest-environment jsdom
/** The dashboard follows one Workspace at a time, mounts its Remote and slots, and withdraws both on disposal. */
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { AppealId, ArchitectureSnapshot } from '@deepseek-ai/dsh-experimental-api-architecture/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { apply as hostApply } from '../src/index.ts'
import { ArchitecturePage, type ArchitecturePageInjected } from '../src/client/ArchitecturePage.tsx'
import { ArchitectureIcon } from '../src/client/ArchitectureIcon.tsx'
import { createDashboardSource } from '../src/client/dashboard-source.ts'
import { ARCHITECT_PRESET, inject, mountArchitecture } from '../src/client/mount.ts'
import { apply as clientApply } from '../src/client/index.ts'

// The generated contribution is a build artifact; the entry only forwards it.
vi.mock('@deepseek-ai/dsh-experimental-api-architecture/remote', () => ({
  default: { package: '@deepseek-ai/dsh-experimental-api-architecture', descriptors: [] },
}))

const REMOTE: TypertRemoteContribution = { package: '@deepseek-ai/dsh-experimental-api-architecture', descriptors: [] }
const WS = 'ws-1' as WorkspaceId
const WS2 = 'ws-2' as WorkspaceId
const snapshot = { root: '/repo' } as ArchitectureSnapshot

interface OpenedStream {
  readonly options: RemoteStreamOptions<ArchitectureSnapshot>
  readonly push: (value: ArchitectureSnapshot) => void
  readonly fail: (error: unknown) => void
  disposed: boolean
}

/** A controllable `$stream`: each opened logical stream yields what the test pushes. */
function streams() {
  const opened: OpenedStream[] = []
  const $stream = (options: RemoteStreamOptions<ArchitectureSnapshot>) => {
    const queue: Array<{ value?: ArchitectureSnapshot; error?: unknown }> = []
    let wake: (() => void) | undefined
    const entry = {
      options,
      push: (value: ArchitectureSnapshot) => { queue.push({ value }); wake?.() },
      fail: (error: unknown) => { queue.push({ error }); wake?.() },
      disposed: false,
    }
    opened.push(entry)
    return {
      async *[Symbol.asyncIterator]() {
        while (!entry.disposed) {
          const next = queue.shift()
          if (next === undefined) { await new Promise<void>((resolve) => { wake = resolve }); continue }
          if ('error' in next) throw next.error
          if (next.value !== undefined) yield { value: next.value, accept: vi.fn(), generation: 1, signal: new AbortController().signal }
        }
      },
      dispose: async () => { entry.disposed = true; wake?.() },
    }
  }
  return { opened, $stream }
}

describe('dashboard source', () => {
  it('follows the selected Workspace, reports failures, and closes the previous stream', async () => {
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const { opened, $stream } = streams()
    const follow = vi.fn()
    ctx.provide('remote', { architecture: { follow }, $stream })
    const source = createDashboardSource(ctx)
    source.select(WS)
    source.select(WS)
    expect(opened).toHaveLength(1)
    const signal = new AbortController().signal
    opened[0]?.options.open(signal)
    expect(follow).toHaveBeenCalledWith(WS, signal)
    expect(opened[0]?.options.ended(true)).toBeInstanceOf(RemoteStreamCarrierError)
    opened[0]?.push(snapshot)
    await vi.waitFor(() => { expect(source.state.getSnapshot()).toEqual({ workspaceId: WS, snapshot, error: null }) })
    opened[0]?.options.carrierFailed?.(new RemoteStreamCarrierError('connection lost'))
    expect(source.state.getSnapshot().error).toBe('connection lost')

    source.select(WS2)
    expect(opened[0]?.disposed).toBe(true)
    expect(source.state.getSnapshot()).toEqual({ workspaceId: WS2, snapshot: null, error: null })
    opened[1]?.fail('denied')
    await vi.waitFor(() => { expect(source.state.getSnapshot().error).toBe('denied') })
    // A failure reported by a stream that was already replaced is not shown.
    opened[0]?.options.carrierFailed?.(new RemoteStreamCarrierError('stale'))
    expect(source.state.getSnapshot().error).toBe('denied')

    source.select(null)
    expect(opened).toHaveLength(2)
    await source.dispose()
    source.select(WS)
    await source.dispose()
    expect(opened[2]?.disposed).toBe(true)
  })
})

async function fixture(options: { fail?: boolean; workspaces?: Array<{ workspaceId: WorkspaceId; title: string }> } = {}) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const unmount = vi.fn(async () => {})
  class Remote extends Service {
    readonly $stream = streams().$stream
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toEqual(REMOTE)
      return unmount
    }
  }
  new Remote()
  const architecture = {
    follow: vi.fn(),
    section: vi.fn(async () => ({ ok: true as const, value: { path: 'a.md', anchor: 'a', hash: 'h', text: 't' } })),
    accept: vi.fn(async () => ({ ok: true as const, value: {} })),
    adjudicate: vi.fn(async () => ({ ok: false as const, error: new Error('x') })),
  }
  ctx.provide('remote.architecture', architecture)
  const select = vi.fn(async () => ({ ok: true as const, value: ARCHITECT_PRESET }))
  ctx.provide('remote.agentPresets', { select })
  let items = options.workspaces ?? []
  const listeners = new Set<() => void>()
  let listSnapshot = { items }
  const list = {
    getSnapshot: () => listSnapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const setWorkspaces = (next: typeof items): void => {
    items = next
    listSnapshot = { items }
    for (const listener of listeners) listener()
  }
  ctx.provide('workspaces', { list })
  const create = vi.fn(async () => 'session-new')
  ctx.provide('sessions', { create })
  const openSession = vi.fn()
  ctx.provide('uiWorkspace', { openSession })
  ctx.provide('layout', {})
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry)
  ctx.slots.register({ name: 'root', children: {
    'main': { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  if (options.fail === true) vi.spyOn(ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot failed') })
  return { ctx, unmount, architecture, select, create, openSession, setWorkspaces, listeners }
}

/** Narrow the erased registry payload before exercising its registered actions. */
function assertDashboardActions(
  value: Record<string, unknown> | undefined,
): asserts value is Record<string, unknown> & ArchitecturePageInjected {
  assert(value !== undefined)
  for (const name of ['selectWorkspace', 'discuss', 'readSection', 'accept', 'adjudicate']) assert(typeof value[name] === 'function')
  assert(typeof value.hooks === 'object' && value.hooks !== null)
}

function injected(ctx: Context): ArchitecturePageInjected {
  const entry = ctx.slots.entries('main').find(item => item.component === ArchitecturePage)
  const value = entry?.inject?.()
  assertDashboardActions(value)
  return value
}

describe('mountArchitecture', () => {
  it('registers the page and sidebar entry, forwards actions, and withdraws everything on disposal', async () => {
    hostApply()
    const b = await fixture({ workspaces: [{ workspaceId: WS, title: 'repo' }] })
    const fiber = b.ctx.plugin({ inject: [...inject], apply: ctx => mountArchitecture(ctx, REMOTE) })
    await fiber
    const sidebar = b.ctx.slots.entries('sidebar.panellist').find(item => item.component === ArchitectureIcon)
    expect(sidebar).toMatchObject({ locale: 'architecture', options: { id: 'architecture' } })
    const label = sidebar?.options.label
    expect(typeof label === 'function' ? label() : label).toBe('Architecture')
    const actions = injected(b.ctx)
    expect(actions.hooks.architectureDashboard.getSnapshot().workspaceId).toBe(WS)
    expect(actions.hooks.architectureWorkspaces.getSnapshot()).toEqual([{ workspaceId: WS, title: 'repo' }])
    expect(actions.hooks.architectureWorkspaces.getSnapshot()).toBe(actions.hooks.architectureWorkspaces.getSnapshot())

    b.setWorkspaces([{ workspaceId: WS, title: 'repo' }, { workspaceId: WS2, title: 'other' }])
    expect(actions.hooks.architectureDashboard.getSnapshot().workspaceId).toBe(WS)
    const unsubscribe = actions.hooks.architectureWorkspaces.subscribe(() => {})
    unsubscribe()
    actions.selectWorkspace(WS2)
    expect(actions.hooks.architectureDashboard.getSnapshot().workspaceId).toBe(WS2)

    expect(await actions.discuss(WS)).toBe(true)
    expect(b.create).toHaveBeenCalledWith({ workspaceId: WS })
    expect(b.select).toHaveBeenCalledWith('session-new', 'architect')
    expect(b.openSession).toHaveBeenCalledWith('session-new')
    b.select.mockResolvedValueOnce({ ok: false, error: new Error('refused') } as never)
    expect(await actions.discuss(WS)).toBe(false)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    b.create.mockRejectedValueOnce(new Error('offline'))
    expect(await actions.discuss(WS)).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()

    expect(await actions.readSection(WS, 'a.md', 'a')).toMatchObject({ text: 't' })
    b.architecture.section.mockResolvedValueOnce({ ok: false, error: new Error('gone') } as never)
    expect(await actions.readSection(WS, 'a.md', 'a')).toBeUndefined()
    expect(await actions.accept(WS, { path: 'a.md', anchor: 'a', hash: 'h', text: 't' })).toBe(true)
    expect(b.architecture.accept).toHaveBeenCalledWith({ workspaceId: WS, path: 'a.md', anchor: 'a', hash: 'h' })
    expect(await actions.adjudicate(WS, 'appeal-1' as AppealId, { kind: 'uphold' })).toBe(false)
    expect(b.architecture.adjudicate).toHaveBeenCalledWith({ workspaceId: WS, appealId: 'appeal-1', adjudication: { kind: 'uphold' } })

    await fiber.dispose()
    expect(b.ctx.slots.entries('main')).toHaveLength(0)
    expect(b.ctx.slots.entries('sidebar.panellist')).toHaveLength(0)
    expect(b.listeners.size).toBe(0)
    expect(b.unmount).toHaveBeenCalledOnce()
  })

  it('follows the first Workspace once one exists', async () => {
    const b = await fixture()
    await b.ctx.plugin({ inject: [...inject], apply: ctx => mountArchitecture(ctx, REMOTE) })
    const actions = injected(b.ctx)
    expect(actions.hooks.architectureDashboard.getSnapshot().workspaceId).toBeNull()
    b.setWorkspaces([{ workspaceId: WS2, title: 'other' }])
    expect(actions.hooks.architectureDashboard.getSnapshot().workspaceId).toBe(WS2)
  })

  it('mounts the generated contribution through the browser entry and renders the sidebar glyph', async () => {
    const b = await fixture()
    const dispose = await clientApply(b.ctx)
    expect(b.ctx.slots.entries('main')).toHaveLength(1)
    const view = render(createElement(ArchitectureIcon, { size: 16 } as never))
    expect(view.container.querySelector('svg')).not.toBeNull()
    cleanup()
    await dispose()
    expect(b.ctx.slots.entries('main')).toHaveLength(0)
  })

  it('rolls back the Remote contribution when the slot registration fails', async () => {
    const b = await fixture({ fail: true })
    await expect(mountArchitecture(b.ctx, REMOTE)).rejects.toThrow('slot failed')
    expect(b.unmount).toHaveBeenCalledOnce()
  })
})
