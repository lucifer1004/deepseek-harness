/** The architect-model form stages one catalog route, saves its three fields in one mutation, and loads the catalog once. */
import { describe, expect, it, vi } from 'vitest'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createArchitectModelForm, type ArchitectModelSettings } from '../src/client/architect-model.ts'

const CATALOG: ModelCatalog = {
  default: { provider: 'deepseek', model: 'chat' },
  routableProviders: ['deepseek'],
  groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }] }],
  failures: [],
}

function scope(value: ArchitectModelSettings | undefined, status: ConfigFormSnapshot<ArchitectModelSettings>['status'] = 'ready') {
  let snapshot: ConfigFormSnapshot<ArchitectModelSettings> = {
    status, value, base: undefined, user: undefined, revision: 1, writable: true, mode: 'host',
  }
  const listeners = new Set<() => void>()
  const mutate = vi.fn<ConfigForm<ArchitectModelSettings>['mutate']>(async () => true)
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    mutate,
  } as Partial<ConfigForm<ArchitectModelSettings>> as ConfigForm<ArchitectModelSettings>
  const accept = (next: ArchitectModelSettings | undefined): void => {
    snapshot = { ...snapshot, value: next }
    for (const listener of listeners) listener()
  }
  return { form, mutate, accept, listeners }
}

describe('architect-model form', () => {
  it('projects the saved route and saves a staged route in one mutation', async () => {
    const s = scope({ architectProvider: 'deepseek', architectModel: 'chat', architectReasoningEffort: 'high' })
    const form = createArchitectModelForm(s.form, async () => ({ ok: true, value: CATALOG }))
    expect(form.state.getSnapshot()).toMatchObject({
      available: true, writable: true, saved: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' }, draft: undefined,
    })
    await form.save()
    expect(s.mutate).not.toHaveBeenCalled()

    form.stage({ provider: 'deepseek', model: 'reasoner' })
    expect(form.state.getSnapshot().draft).toEqual({ provider: 'deepseek', model: 'reasoner' })
    await form.save()
    expect(s.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['architectProvider'], value: 'deepseek' },
      { op: 'set', path: ['architectModel'], value: 'reasoner' },
      { op: 'unset', path: ['architectReasoningEffort'] },
    ])
    expect(form.state.getSnapshot()).toMatchObject({ draft: undefined, failed: false, saving: false })

    // Clearing returns the architect to the worker's model.
    form.stage(null)
    await form.save()
    expect(s.mutate).toHaveBeenLastCalledWith(['architectProvider', 'architectModel', 'architectReasoningEffort'].map(field => ({ op: 'unset', path: [field] })))
    s.accept(undefined)
    expect(form.state.getSnapshot().saved).toBeUndefined()
    s.accept({ architectProvider: 'deepseek' })
    expect(form.state.getSnapshot().saved).toBeUndefined()
    s.accept({ architectProvider: 'deepseek', architectModel: 'chat' })
    expect(form.state.getSnapshot().saved).toEqual({ provider: 'deepseek', model: 'chat' })
    form.dispose()
    expect(s.listeners.size).toBe(0)
  })

  it('keeps the draft after a refused or failed save, and drops it on discard', async () => {
    const s = scope({}, 'unavailable')
    const form = createArchitectModelForm(s.form, async () => ({ ok: true, value: CATALOG }))
    expect(form.state.getSnapshot().available).toBe(false)
    form.discard()
    form.stage({ provider: 'p', model: 'm', reasoningEffort: 'low' })
    s.mutate.mockResolvedValueOnce(false)
    await form.save()
    expect(form.state.getSnapshot()).toMatchObject({ failed: true, draft: { provider: 'p', model: 'm' } })
    s.mutate.mockRejectedValueOnce(new Error('offline'))
    await form.save()
    expect(form.state.getSnapshot().failed).toBe(true)
    let release: (value: boolean) => void = () => {}
    s.mutate.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const pending = form.save()
    expect(form.state.getSnapshot().saving).toBe(true)
    await form.save()
    release(true)
    await pending
    expect(s.mutate).toHaveBeenCalledTimes(3)
    form.stage({ provider: 'p', model: 'm' })
    form.discard()
    expect(form.state.getSnapshot()).toMatchObject({ draft: undefined, failed: false })
  })

  it('loads the catalog once and allows a retry after a failure', async () => {
    let resolve: (value: RemoteResult<ModelCatalog>) => void = () => {}
    const load = vi.fn(() => new Promise<RemoteResult<ModelCatalog>>((done) => { resolve = done }))
    const form = createArchitectModelForm(scope(undefined).form, load)
    form.load()
    form.load()
    expect(load).toHaveBeenCalledOnce()
    resolve({ ok: false, error: new Error('down') as never })
    await vi.waitFor(() => { expect(form.state.getSnapshot().catalog).toBe('error') })
    form.load()
    resolve({ ok: true, value: CATALOG })
    await vi.waitFor(() => { expect(form.state.getSnapshot().catalog).toBe('ready') })
    expect(form.state.getSnapshot().groups).toBe(CATALOG.groups)
    form.load()
    expect(load).toHaveBeenCalledTimes(2)
  })
})
