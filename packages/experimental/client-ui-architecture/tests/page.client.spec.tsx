// @vitest-environment jsdom
/** The dashboard lists the index, Rulings, appeals, and local entries of the followed Workspace and forwards user decisions. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AppealId, ArchitectureSnapshot, RulingId } from '@deepseek-ai/dsh-experimental-api-architecture/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ArchitecturePage, type ArchitecturePageProps, type WorkspaceChoice } from '../src/client/ArchitecturePage.tsx'
import type { DashboardState } from '../src/client/dashboard-source.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const WS = 'ws-1' as WorkspaceId
const HASH = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

function snapshot(overrides: Partial<ArchitectureSnapshot> = {}): ArchitectureSnapshot {
  return {
    root: '/repo',
    mainBranch: 'main',
    manifestPath: 'architecture.yml',
    localDirectory: '.architecture',
    hasManifest: true,
    revision: '0123456789abcdef',
    index: {
      root: '/repo',
      sources: ['design/arch.md', 'design/new.md'] as never,
      sections: [
        { path: 'design/arch.md', anchor: 'arch', title: 'Arch', level: 1, line: 1, endLine: 2, hash: HASH },
        { path: 'design/arch.md', anchor: 'storage', title: 'Storage', level: 2, line: 3, endLine: 5, hash: HASH },
        { path: 'design/new.md', anchor: 'draft', title: 'Draft', level: 1, line: 1, endLine: 3, hash: OTHER },
      ] as never,
      diagnostics: [{ path: 'design/bad.md', message: 'too large' }],
    },
    sourceStatus: { 'design/arch.md': 'committed', 'design/new.md': 'untracked' },
    rulings: [{
      version: 1,
      ruling: {
        id: 'ruling-1' as RulingId,
        question: 'Where does persistence go?',
        scope: [],
        summary: 'Use the store.',
        constraints: [{ statement: 'Persist through the store.', citations: [{ path: 'design/arch.md', anchor: 'storage', hash: HASH }] as never }],
        unresolved: [{ statement: 'Use YAML.', reason: 'no citation to an architecture section' }, { statement: 'Caching?' }],
      },
      workerSession: 'worker' as never,
      architectSession: 'architect' as never,
      revision: 'r',
      issuedAt: 0,
      status: 'appealed',
      stale: true,
    }, {
      version: 1,
      ruling: { id: 'ruling-2' as RulingId, question: 'Second?', scope: [], summary: '', constraints: [], unresolved: [] },
      workerSession: 'worker' as never,
      architectSession: 'architect' as never,
      revision: 'r',
      issuedAt: Date.now(),
      status: 'issued',
      stale: false,
    }],
    appeals: [{
      version: 1,
      id: 'appeal-1' as AppealId,
      rulingId: 'ruling-1' as RulingId,
      workerSession: 'worker' as never,
      reason: 'The store cannot stream.',
      evidence: ['src/stream.ts'],
      filedAt: 0,
      delivered: false,
    }, {
      version: 1,
      id: 'appeal-2' as AppealId,
      rulingId: 'ruling-gone' as RulingId,
      workerSession: 'worker' as never,
      reason: 'Old.',
      evidence: [],
      filedAt: 0,
      adjudication: { kind: 'exception', scope: 'src/a.ts', note: 'only there' },
      delivered: true,
    }, {
      version: 1,
      id: 'appeal-3' as AppealId,
      rulingId: 'ruling-2' as RulingId,
      workerSession: 'worker' as never,
      reason: 'Older.',
      evidence: [],
      filedAt: 0,
      adjudication: { kind: 'uphold' },
      delivered: false,
    }],
    acceptances: [],
    localEntries: [{ path: '.architecture/notes.md', status: 'ignored' }],
    problems: [{ file: '.architecture/rulings/x.json', message: 'bad' }],
    ...overrides,
  }
}

/** Expand one source's disclosure row so its sections are listed. */
function expand(path: string): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }))
}

function fixture(state: Partial<DashboardState> = {}, choices: readonly WorkspaceChoice[] = [{ workspaceId: WS, title: 'repo' }]) {
  const dashboard = createSnapshotStore<DashboardState>({ workspaceId: WS, snapshot: snapshot(), error: null, ...state })
  const workspaces = createSnapshotStore<readonly WorkspaceChoice[]>(choices)
  const props = {
    useArchitectureDashboard: bindSnapshotSelector(dashboard),
    useArchitectureWorkspaces: bindSnapshotSelector(workspaces),
    selectWorkspace: vi.fn(),
    discuss: vi.fn(async () => true),
    readSection: vi.fn<ArchitecturePageProps['readSection']>(async (_ws, path, anchor) => ({
      path, anchor, hash: path === 'design/new.md' ? OTHER : HASH, text: `## ${anchor}\n\nBody of ${anchor}.`,
    })),
    accept: vi.fn(async () => true),
    adjudicate: vi.fn(async () => true),
    t: makeTranslate(zh),
  }
  render(<ArchitecturePage {...(props as never as ArchitecturePageProps)} />)
  return { props, dashboard }
}

function tab(name: string): void {
  fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}`) }))
}

describe('ArchitecturePage', () => {
  it('shows the index summary, source status, and reads a section', async () => {
    const { props } = fixture()
    expect(screen.getByText(/分支 main · 2 个来源 · 3 个章节 · 修订 0123456789abcdef/)).toBeTruthy()
    expect(screen.getByText('1 个记录文件无法读取')).toBeTruthy()
    expect(screen.getByText('1 个来源无法索引')).toBeTruthy()
    expect(screen.getByText('未跟踪')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '查看 design/arch.md#storage' })).toBeNull()
    expand('design/arch.md')
    fireEvent.click(screen.getByRole('button', { name: '查看 design/arch.md#storage' }))
    expect(await screen.findByText('Body of storage.')).toBeTruthy()
    expect(props.readSection).toHaveBeenCalledWith(WS, 'design/arch.md', 'storage')
    // A committed section offers no acceptance.
    expect(screen.queryByRole('button', { name: zh['section.accept'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh['section.close'] }))
    expect(screen.queryByText('Body of storage.')).toBeNull()
    expand('design/arch.md')
    expect(screen.queryByRole('button', { name: '查看 design/arch.md#storage' })).toBeNull()
  })

  it('says when the repository declares no main branch', async () => {
    const { dashboard } = fixture()
    expect(screen.queryByText(/没有声明 mainBranch/)).toBeNull()
    const { mainBranch: _omitted, ...withoutBranch } = snapshot()
    dashboard.set({ ...dashboard.getSnapshot(), snapshot: withoutBranch })
    expect(await screen.findByText(/未声明主分支 · 2 个来源 · 3 个章节/)).toBeTruthy()
    expect(screen.getByText('architecture.yml 没有声明 mainBranch，所以架构来源无法修改，只有你接受过的章节可被裁定引用')).toBeTruthy()
  })

  it('accepts an uncommitted section and reports a failed acceptance', async () => {
    const { props, dashboard } = fixture()
    expand('design/new.md')
    fireEvent.click(screen.getByRole('button', { name: '查看 design/new.md#draft' }))
    fireEvent.click(await screen.findByRole('button', { name: zh['section.accept'] }))
    await waitFor(() => { expect(props.accept).toHaveBeenCalledWith(WS, expect.objectContaining({ path: 'design/new.md', hash: OTHER })) })
    props.accept.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: zh['section.accept'] }))
    expect(await screen.findByText(zh['section.acceptFailed'])).toBeTruthy()
    dashboard.set({ ...dashboard.getSnapshot(), snapshot: snapshot({ acceptances: [{ path: 'design/new.md' as never, anchor: 'draft', hash: OTHER as never, acceptedAt: 0 }] }) })
    await waitFor(() => { expect(screen.queryByRole('button', { name: zh['section.accept'] })).toBeNull() })
    // Both the section row and the reader footer mark the accepted content.
    expect(screen.getAllByText(zh['status.accepted'])).toHaveLength(2)
  })

  it('reports a section that cannot be read and ignores a stale read', async () => {
    const { props } = fixture()
    const late = Promise.withResolvers<undefined>()
    props.readSection.mockReturnValueOnce(late.promise)
    props.readSection.mockResolvedValueOnce(undefined)
    expand('design/arch.md')
    fireEvent.click(screen.getByRole('button', { name: '查看 design/arch.md#arch' }))
    fireEvent.click(screen.getByRole('button', { name: '查看 design/arch.md#storage' }))
    expect(await screen.findByText(zh['section.failed'])).toBeTruthy()
    late.resolve(undefined)
    await waitFor(() => { expect(screen.getByRole('article', { name: 'design/arch.md#storage' })).toBeTruthy() })
  })

  it('lists Rulings with status, staleness, constraints, and unresolved points', () => {
    fixture()
    tab(zh['tab.consultations'])
    expect(screen.getByText('Where does persistence go?')).toBeTruthy()
    expect(screen.getByText(zh['ruling.status.appealed'])).toBeTruthy()
    expect(screen.getByText(zh['ruling.stale'])).toBeTruthy()
    expect(screen.getByText('Persist through the store.')).toBeTruthy()
    expect(screen.getByText('design/arch.md#storage')).toBeTruthy()
    expect(screen.getByText('no citation to an architecture section')).toBeTruthy()
    expect(screen.getByText(zh['ruling.noConstraints'])).toBeTruthy()
    // Times use the sidebar's relative form: an old Ruling in years ago, a fresh one as now.
    expect(screen.getByText(/ruling-1 · \d+年前 · 会话/)).toBeTruthy()
    expect(screen.getByText(/ruling-2 · 刚刚 · 会话/)).toBeTruthy()
  })

  it('decides a pending appeal and shows decided appeals', async () => {
    const { props } = fixture()
    tab(zh['tab.appeals'])
    expect(screen.getByRole('tab', { name: `${zh['tab.appeals']} · 1` })).toBeTruthy()
    expect(screen.getByText('已豁免：src/a.ts')).toBeTruthy()
    expect(screen.getByText(/only there · 已送达工作会话/)).toBeTruthy()
    expect(screen.getByText(zh['appeal.undelivered'])).toBeTruthy()
    expect(screen.getByText('针对裁定 ruling-gone', { exact: false })).toBeTruthy()
    const pending = screen.getByText('The store cannot stream.').closest('li')
    if (pending === null) throw new Error('pending appeal card missing')
    const card = within(pending)
    card.getByText('src/stream.ts')

    expect(card.getByRole('tablist', { name: zh['appeal.decision'] })).toBeTruthy()
    fireEvent.click(card.getByRole('tab', { name: zh['appeal.exception'] }))
    const submit = card.getByRole('button', { name: zh['appeal.submit'] })
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.change(card.getByLabelText(zh['appeal.exceptionScope']), { target: { value: ' src/stream.ts ' } })
    fireEvent.change(card.getByLabelText(zh['appeal.note']), { target: { value: ' streaming only ' } })
    fireEvent.click(submit)
    await waitFor(() => {
      expect(props.adjudicate).toHaveBeenCalledWith(WS, 'appeal-1', { kind: 'exception', scope: 'src/stream.ts', note: 'streaming only' })
    })

    props.adjudicate.mockResolvedValueOnce(false)
    fireEvent.click(card.getByRole('tab', { name: zh['appeal.overturn'] }))
    fireEvent.change(card.getByLabelText(zh['appeal.note']), { target: { value: '' } })
    fireEvent.click(submit)
    expect(await card.findByText(zh['appeal.failed'])).toBeTruthy()
    expect(props.adjudicate).toHaveBeenLastCalledWith(WS, 'appeal-1', { kind: 'overturn' })
    fireEvent.click(card.getByRole('tab', { name: zh['appeal.uphold'] }))
    fireEvent.click(submit)
    await waitFor(() => { expect(props.adjudicate).toHaveBeenLastCalledWith(WS, 'appeal-1', { kind: 'uphold' }) })
  })

  it('lists local entries with their git status, and the empty views', async () => {
    const { dashboard } = fixture()
    tab(zh['tab.local'])
    expect(screen.getByTitle('.architecture/notes.md')).toBeTruthy()
    expect(screen.getByText(zh['status.ignored'])).toBeTruthy()
    const emptied = snapshot({ localEntries: [], rulings: [], appeals: [], problems: [], hasManifest: false })
    dashboard.set({ ...dashboard.getSnapshot(), snapshot: emptied })
    expect(await screen.findByText('.architecture 下没有本地条目')).toBeTruthy()
    tab(zh['tab.consultations'])
    expect(screen.getByText(zh['consultations.empty'])).toBeTruthy()
    tab(zh['tab.appeals'])
    expect(screen.getByText(zh['appeals.empty'])).toBeTruthy()
    tab(zh['tab.architecture'])
    expect(screen.getByText(/此仓库还没有 architecture.yml/)).toBeTruthy()
  })

  it('opens an Architecture Session and reports a failure to open one', async () => {
    const { props } = fixture()
    fireEvent.click(screen.getByRole('button', { name: zh.discuss }))
    await waitFor(() => { expect(props.discuss).toHaveBeenCalledWith(WS) })
    expect(screen.queryByText(zh['discuss.failed'])).toBeNull()
    props.discuss.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole('button', { name: zh.discuss }))
    expect(await screen.findByText(zh['discuss.failed'])).toBeTruthy()
  })

  it('switches Workspace and shows loading, error, unselected, and no-Workspace states', async () => {
    const { props, dashboard } = fixture({ snapshot: null }, [{ workspaceId: WS, title: 'repo' }, { workspaceId: 'ws-2' as WorkspaceId, title: 'other' }])
    expect(screen.getByRole('status', { name: zh['section.loading'] })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.label'] }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'other' }))
    expect(props.selectWorkspace).toHaveBeenCalledWith('ws-2')
    expect(screen.queryByRole('menuitem', { name: 'other' })).toBeNull()
    // Escape closes the menu without choosing.
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.label'] }))
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'other' }), { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('menuitem', { name: 'other' })).toBeNull() })
    expect(props.selectWorkspace).toHaveBeenCalledTimes(1)
    dashboard.set({ workspaceId: WS, snapshot: null, error: 'offline' })
    expect(await screen.findByText('无法读取架构状态：offline')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    dashboard.set({ workspaceId: null, snapshot: null, error: null })
    await waitFor(() => { expect(screen.getByText(zh['workspace.none'])).toBeTruthy() })
    expect(screen.getByRole('button', { name: zh['workspace.label'] }).textContent).toBe(zh['workspace.choose'])
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.label'] }))
    fireEvent.click(screen.getByRole('button', { name: zh['workspace.label'] }))
    expect(screen.queryByRole('menuitem', { name: 'other' })).toBeNull()
    expect(screen.queryByRole('button', { name: zh.discuss })).toBeNull()
    expect(props.selectWorkspace).toHaveBeenCalledTimes(1)
    cleanup()
    fixture({ workspaceId: null, snapshot: null }, [])
    expect(screen.getByText(zh['workspace.empty'])).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh['workspace.label'] })).toBeNull()
  })
})
