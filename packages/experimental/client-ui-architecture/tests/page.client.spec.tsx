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
import type { ArchitectModelForm, ArchitectModelState } from '../src/client/architect-model.ts'
import { en, zh, type ArchitectureKey } from '../src/client/locales.ts'

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
        proposedEdits: [],
      },
      workerSession: 'worker' as never,
      architectSession: 'architect' as never,
      revision: 'r',
      issuedAt: 0,
      status: 'appealed',
      appliedEdits: [],
      stale: true,
    }, {
      version: 1,
      ruling: { id: 'ruling-2' as RulingId, question: 'Second?', scope: [], summary: '', constraints: [], unresolved: [], proposedEdits: [] },
      workerSession: 'worker' as never,
      architectSession: 'architect' as never,
      revision: 'r',
      issuedAt: Date.now(),
      status: 'issued',
      appliedEdits: [],
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

/** A snapshot of a repository whose manifest declares no main branch. */
function undeclared(overrides: Partial<ArchitectureSnapshot> = {}): ArchitectureSnapshot {
  const { mainBranch: _omitted, ...rest } = snapshot(overrides)
  return rest
}

/** Expand one source's disclosure row so its sections are listed. */
/** Toggle the source row of `path`; rows are titled by file name under their directory. */
function expand(path: string): void {
  const name = path.slice(path.lastIndexOf('/') + 1)
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }))
}

/** An architect-model form over a store the test drives; actions are spies. */
function modelForm(state: Partial<ArchitectModelState> = {}) {
  const store = createSnapshotStore<ArchitectModelState>({
    available: true, writable: true, saved: undefined, draft: undefined, catalog: 'ready', saving: false, failed: false,
    groups: [
      { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'chat', name: 'Chat' }, {
        id: 'reasoner', name: 'Reasoner', reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }] },
      }] },
    ],
    ...state,
  })
  const form: ArchitectModelForm = {
    state: store,
    stage: vi.fn<ArchitectModelForm['stage']>((choice) => { store.set({ ...store.getSnapshot(), draft: choice }) }),
    save: vi.fn(async () => {}),
    discard: vi.fn(),
    load: vi.fn(),
    dispose: vi.fn(),
  }
  return { form, store }
}

function fixture(
  state: Partial<DashboardState> = {},
  choices: readonly WorkspaceChoice[] = [{ workspaceId: WS, title: 'repo' }],
  architectModel?: ArchitectModelForm,
  dictionary: Record<ArchitectureKey, string> = zh,
) {
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
    setMainBranch: vi.fn<ArchitecturePageProps['setMainBranch']>(async () => undefined),
    applyProposedEdit: vi.fn<ArchitecturePageProps['applyProposedEdit']>(async () => undefined),
    architectModel,
    t: makeTranslate(dictionary),
  }
  render(<ArchitecturePage {...(props as never as ArchitecturePageProps)} />)
  return { props, dashboard }
}

/** Open the collapsed card or section whose heading is `name`. */
function unfold(name: string | RegExp): void {
  fireEvent.click(screen.getByRole('button', { name, expanded: false }))
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

  it('groups sources by directory, searches paths and titles, and narrows to uncommitted sources', () => {
    const many = Array.from({ length: 13 }, (_, n) => `notes/n${String(n)}.md`)
    const base = snapshot()
    const sections = [
      ...base.index.sections,
      { path: 'README.md', anchor: '', title: '', level: 0, line: 1, endLine: 1, hash: HASH },
      ...many.map(path => ({ path, anchor: 'note', title: `Note ${path}`, level: 1, line: 1, endLine: 1, hash: HASH })),
    ]
    const status = { ...base.sourceStatus, 'README.md': 'committed', ...Object.fromEntries(many.map(path => [path, 'committed'])) }
    fixture({ snapshot: { ...base, index: { ...base.index, sections: sections as never }, sourceStatus: status as never } })
    // Many sources start with every directory closed; committed sources carry no status tag.
    expect(screen.getByText('16 个来源 · 17 个章节')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^design\// }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(zh['status.committed'])).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${zh['index.root']}`) }))
    expand('README.md')
    expect(screen.getByRole('button', { name: '查看 README.md#' }).textContent).toBe(zh['section.preamble'])

    // A query opens what it matched: a title match shows only that section, a path match all of the source.
    const search = screen.getByRole('searchbox', { name: zh['index.search'] })
    fireEvent.change(search, { target: { value: 'STORAGE' } })
    expect(screen.getByText('1 个来源 · 1 个章节')).toBeTruthy()
    expect(screen.getByText('1 / 2 个章节')).toBeTruthy()
    expect(screen.getByRole('button', { name: '查看 design/arch.md#storage' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '查看 design/arch.md#arch' })).toBeNull()
    fireEvent.change(search, { target: { value: 'design/arch' } })
    expect(screen.getByRole('button', { name: '查看 design/arch.md#arch' })).toBeTruthy()
    // The user may still close a directory the query opened.
    fireEvent.click(screen.getByRole('button', { name: /^design\// }))
    expect(screen.queryByRole('button', { name: '查看 design/arch.md#arch' })).toBeNull()
    fireEvent.change(search, { target: { value: 'nothing-matches' } })
    expect(screen.getByText(zh['index.noMatch'])).toBeTruthy()

    fireEvent.change(search, { target: { value: '' } })
    fireEvent.click(screen.getByRole('tab', { name: zh['index.scope.uncommitted'] }))
    expect(screen.getByText('1 个来源 · 1 个章节')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^arch\.md/ })).toBeNull()
  })

  it('writes English counts in the singular for one and the plural otherwise', async () => {
    const base = snapshot()
    const first = base.rulings[0]
    if (first === undefined) throw new Error('fixture has no Ruling')
    const single = {
      ...base,
      index: { ...base.index, sources: ['design/arch.md'] as never, sections: base.index.sections.slice(1, 2), diagnostics: [] },
      rulings: [{ ...first, ruling: { ...first.ruling, proposedEdits: [{ path: 'design/arch.md', anchor: 'storage', hash: HASH, content: 'x', rationale: 'r' }] as never } }],
    }
    const { dashboard } = fixture({ snapshot: single }, undefined, undefined, en)
    expect(screen.getByText(/^Branch main · 1 source · 1 section · revision/)).toBeTruthy()
    expect(screen.getByText('1 record file could not be read')).toBeTruthy()
    expect(screen.getByText('1 source · 1 section')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: en['tab.consultations'] }))
    expect(screen.getByText('1 constraint · 2 unresolved · 1 proposed edit')).toBeTruthy()
    const diagnostics = [{ path: 'a.md', message: 'x' }, { path: 'b.md', message: 'y' }] as never
    dashboard.set({ ...dashboard.getSnapshot(), snapshot: snapshot({ problems: [{ file: 'a', message: 'b' }, { file: 'c', message: 'd' }] as never }) })
    expect(await screen.findByText('2 record files could not be read')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: en['tab.architecture'] }))
    expect(screen.getByText('1 source could not be indexed')).toBeTruthy()
    const twice = snapshot()
    dashboard.set({ ...dashboard.getSnapshot(), snapshot: { ...twice, index: { ...twice.index, diagnostics } } })
    expect(await screen.findByText('2 sources could not be indexed')).toBeTruthy()
  })

  it('explains a workspace outside version control and offers no discussion there', async () => {
    const { dashboard } = fixture()
    expect(screen.getByRole('button', { name: '讨论架构' })).toBeTruthy()
    dashboard.set({ ...dashboard.getSnapshot(), snapshot: { ...snapshot(), unsupported: { kind: 'no-repository' } } })
    expect(await screen.findByText(/此工作区不在 git 或 jj 仓库中/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '讨论架构' })).toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
    dashboard.set({ ...dashboard.getSnapshot(), snapshot: { ...snapshot(), unsupported: { kind: 'vcs-missing', vcs: 'jj' } } })
    expect(await screen.findByText('此工作区是 jj 仓库，但未找到 jj 可执行文件。安装后重启服务即可使用')).toBeTruthy()
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
    // Collapsed, a card shows its question, tags, and counts only.
    expect(screen.getByText('Where does persistence go?')).toBeTruthy()
    expect(screen.getByText(zh['ruling.status.appealed'])).toBeTruthy()
    expect(screen.getByText(zh['ruling.stale'])).toBeTruthy()
    expect(screen.getByText('1 条约束 · 2 个未决点')).toBeTruthy()
    expect(screen.getByText('0 条约束')).toBeTruthy()
    expect(screen.queryByText('Persist through the store.')).toBeNull()
    unfold('Where does persistence go?')
    unfold('Second?')
    expect(screen.getByText('Use the store.')).toBeTruthy()
    expect(screen.getByText('Persist through the store.')).toBeTruthy()
    // Unresolved points stay folded inside an open card.
    expect(screen.queryByText('no citation to an architecture section')).toBeNull()
    unfold(zh['ruling.unresolved'])
    expect(screen.getByText('design/arch.md#storage')).toBeTruthy()
    expect(screen.getByText('no citation to an architecture section')).toBeTruthy()
    expect(screen.getByText(zh['ruling.noConstraints'])).toBeTruthy()
    // Times use the sidebar's relative form: an old Ruling in years ago, a fresh one as now.
    expect(screen.getByText(/ruling-1 · \d+年前 · 会话/)).toBeTruthy()
    expect(screen.getByText(/ruling-2 · 刚刚 · 会话/)).toBeTruthy()
  })

  it('shows proposed edits against the current section and applies them, with or without acceptance', async () => {
    const base = snapshot()
    const first = base.rulings[0]
    if (first === undefined) throw new Error('fixture has no Ruling')
    const proposal = (anchor: string, hash: string, rationale: string) => ({ path: 'design/arch.md', anchor, hash, content: `## ${anchor}\n\nRevised.`, rationale }) as never
    const withEdits = {
      ...base,
      rulings: [{
        ...first,
        ruling: { ...first.ruling, proposedEdits: [proposal('storage', HASH, 'name the port'), proposal('arch', OTHER, 'stale one'), proposal('gone', HASH, 'gone one')] },
      }],
      index: { ...base.index, sections: [...base.index.sections, { path: 'design/arch.md', anchor: 'gone', title: 'Gone', level: 2, line: 6, endLine: 7, hash: HASH }] as never },
    }
    const { props, dashboard } = fixture({ snapshot: withEdits })
    // A long current section collapses the middle of the diff.
    const long = Array.from({ length: 30 }, (_, line) => `Line ${String(line)}.`).join('\n')
    props.readSection.mockImplementation(async (_ws, path, anchor) => anchor === 'gone' ? undefined : { path, anchor, hash: HASH, text: `## ${anchor}\n\n${long}` })
    tab(zh['tab.consultations'])
    expect(screen.getByText('1 条约束 · 2 个未决点 · 3 条修改提议')).toBeTruthy()
    unfold('Where does persistence go?')
    expect(screen.getByText(zh['ruling.proposedEdits'])).toBeTruthy()
    expect(screen.getByText('name the port')).toBeTruthy()
    // The section the architect read changed, so the proposal cannot be applied.
    expect(screen.getByText(zh['ruling.proposedEdit.changed'])).toBeTruthy()
    expect(screen.getByText(zh['ruling.proposedEdit.changedHint'])).toBeTruthy()
    // A diff, and with it the actions, appears only when the user opens it; the section is read then.
    expect(props.readSection).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: zh['ruling.proposedEdit.apply'] })).toBeNull()
    for (const toggle of screen.getAllByRole('button', { name: zh['ruling.proposedEdit.changes'], expanded: false })) fireEvent.click(toggle)
    expect(await screen.findByText(zh['section.failed'])).toBeTruthy()
    expect(await screen.findByText(/Revised\./)).toBeTruthy()
    expect(props.readSection).toHaveBeenCalledWith(WS, 'design/arch.md', 'storage')
    fireEvent.click(screen.getByRole('button', { name: /展开其余 \d+ 行差异/ }))
    expect(screen.getByRole('button', { name: zh['diff.collapse'] })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: zh['ruling.proposedEdit.applyAccept'] }))
    await waitFor(() => { expect(props.applyProposedEdit).toHaveBeenCalledWith(WS, 'ruling-1', 0, true) })
    props.applyProposedEdit.mockResolvedValueOnce('design/arch.md#storage changed since it was read')
    fireEvent.click(screen.getByRole('button', { name: zh['ruling.proposedEdit.apply'] }))
    expect(await screen.findByText('未能应用：design/arch.md#storage changed since it was read')).toBeTruthy()
    expect(props.applyProposedEdit).toHaveBeenLastCalledWith(WS, 'ruling-1', 0, false)

    // Once applied, the proposal shows its state and no longer offers the actions.
    const applied = { ...withEdits, rulings: [{ ...withEdits.rulings[0], appliedEdits: [0] }] as never }
    dashboard.set({ ...dashboard.getSnapshot(), snapshot: applied })
    expect(await screen.findByText(zh['ruling.proposedEdit.applied'])).toBeTruthy()
    await waitFor(() => { expect(screen.queryByRole('button', { name: zh['ruling.proposedEdit.apply'] })).toBeNull() })
  })

  it('drops a section read that finishes after its proposal left the screen', async () => {
    const base = snapshot()
    const first = base.rulings[0]
    if (first === undefined) throw new Error('fixture has no Ruling')
    const edit = { path: 'design/arch.md', anchor: 'storage', hash: HASH, content: '## Storage\n\nRevised.', rationale: 'late' } as never
    const { props } = fixture({ snapshot: { ...base, rulings: [{ ...first, ruling: { ...first.ruling, proposedEdits: [edit] } }] } })
    let finish: (value: undefined) => void = () => undefined
    props.readSection.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    tab(zh['tab.consultations'])
    unfold('Where does persistence go?')
    unfold(zh['ruling.proposedEdit.changes'])
    await waitFor(() => { expect(props.readSection).toHaveBeenCalled() })
    tab(zh['tab.architecture'])
    finish(undefined)
    await Promise.resolve()
    expect(screen.queryByText(zh['section.failed'])).toBeNull()
  })

  it('decides a pending appeal and shows decided appeals', async () => {
    const { props } = fixture()
    tab(zh['tab.appeals'])
    expect(screen.getByRole('tab', { name: `${zh['tab.appeals']} · 1` })).toBeTruthy()
    expect(screen.getByText('已豁免：src/a.ts')).toBeTruthy()
    // A decided appeal is collapsed; a pending one is open for the decision.
    expect(screen.queryByText(/only there · 已送达工作会话/)).toBeNull()
    for (const toggle of screen.getAllByRole('button', { expanded: false })) fireEvent.click(toggle)
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

  it('declares any local branch as the main branch, marks the current ones, and reports the outcome', async () => {
    const { props, dashboard } = fixture({ snapshot: undeclared({ branches: { all: ['dev', 'main', 'trunk'], current: ['trunk'] } }) })
    tab(zh['tab.settings'])
    const branch = screen.getByLabelText<HTMLSelectElement>(zh['settings.mainBranch'])
    expect(branch.value).toBe('')
    expect([...branch.options].map(option => option.textContent)).toEqual([zh['settings.mainBranch.choose'], 'dev', 'main', 'trunk · 当前所在'])
    expect(screen.getByText(zh['settings.mainBranch.hint'])).toBeTruthy()
    const write = screen.getByRole<HTMLButtonElement>('button', { name: zh['settings.mainBranch.apply'] })
    expect(write.disabled).toBe(true)
    // Without a settings client there is no profile group.
    expect(screen.queryByText(zh['settings.profile'])).toBeNull()
    fireEvent.change(branch, { target: { value: 'main' } })
    fireEvent.click(write)
    await waitFor(() => { expect(props.setMainBranch).toHaveBeenCalledWith(WS, 'main') })
    expect(await screen.findByText('已写入 architecture.yml，请审阅并提交')).toBeTruthy()

    // A declared branch that no longer exists is still listed, and the write needs a different choice.
    props.setMainBranch.mockResolvedValueOnce('dev is not a local bookmark of this repository')
    dashboard.set({ ...dashboard.getSnapshot(), snapshot: snapshot({ vcs: 'jj', mainBranch: 'gone', branches: { all: ['dev'], current: [] } }) })
    await waitFor(() => { expect(branch.value).toBe('gone') })
    expect([...branch.options].map(option => option.textContent)).toEqual(['gone', 'dev'])
    expect(screen.getByText(zh['settings.mainBranch.hint.jj'])).toBeTruthy()
    expect(write.disabled).toBe(true)
    fireEvent.change(branch, { target: { value: 'dev' } })
    fireEvent.click(write)
    expect(await screen.findByText('未能写入：dev is not a local bookmark of this repository')).toBeTruthy()
  })

  it('explains why the main branch cannot be declared', async () => {
    const { dashboard } = fixture({ snapshot: undeclared({ hasManifest: false, branches: { all: ['main'], current: ['main'] } }) })
    tab(zh['tab.settings'])
    expect(screen.getByText('此仓库还没有 architecture.yml，请先开启架构讨论建立它')).toBeTruthy()
    expect(screen.getByLabelText<HTMLSelectElement>(zh['settings.mainBranch']).disabled).toBe(true)
    dashboard.set({ ...dashboard.getSnapshot(), snapshot: undeclared() })
    await waitFor(() => { expect(screen.getByText(zh['settings.mainBranch.noBranches'])).toBeTruthy() })
    dashboard.set({ ...dashboard.getSnapshot(), snapshot: undeclared({ vcs: 'jj' }) })
    await waitFor(() => { expect(screen.getByText(zh['settings.mainBranch.noBookmarks'])).toBeTruthy() })
  })

  it('stages the architect model and its reasoning effort, then saves', async () => {
    const { form, store } = modelForm({ saved: { provider: 'gone', model: 'old' } })
    fixture({}, undefined, form)
    tab(zh['tab.settings'])
    expect(form.load).toHaveBeenCalled()
    expect(screen.getByText(zh['settings.profile'])).toBeTruthy()
    const model = screen.getByLabelText(zh['settings.architectModel']) as HTMLSelectElement
    expect(model.selectedOptions[0]?.textContent).toBe('gone/old（当前不可用）')
    const save = screen.getByRole('button', { name: zh['settings.save'] }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(model, { target: { value: 'deepseek\nreasoner' } })
    expect(form.stage).toHaveBeenLastCalledWith({ provider: 'deepseek', model: 'reasoner' })
    const effort = screen.getByLabelText(zh['settings.architectModel.effort']) as HTMLSelectElement
    fireEvent.change(effort, { target: { value: 'high' } })
    expect(form.stage).toHaveBeenLastCalledWith({ provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' })
    fireEvent.change(effort, { target: { value: '' } })
    expect(form.stage).toHaveBeenLastCalledWith({ provider: 'deepseek', model: 'reasoner' })
    fireEvent.click(save)
    expect(form.save).toHaveBeenCalledOnce()
    fireEvent.change(model, { target: { value: '' } })
    expect(form.stage).toHaveBeenLastCalledWith(null)
    expect(screen.queryByLabelText(zh['settings.architectModel.effort'])).toBeNull()
    store.set({ ...store.getSnapshot(), saving: true })
    expect(await screen.findByRole('button', { name: zh['settings.saving'] })).toBeTruthy()
    store.set({ ...store.getSnapshot(), saving: false, failed: true, catalog: 'error', writable: false })
    expect(await screen.findByText(zh['settings.saveFailed'])).toBeTruthy()
    expect(screen.getByText(zh['settings.readOnly'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh['settings.architectModel.retry'] }))
    expect(form.load).toHaveBeenCalledTimes(2)
    tab(zh['tab.local'])
    expect(form.discard).toHaveBeenCalledOnce()
    tab(zh['tab.settings'])
    store.set({ ...store.getSnapshot(), available: false })
    expect(await screen.findByText(zh['settings.unavailable'])).toBeTruthy()
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
