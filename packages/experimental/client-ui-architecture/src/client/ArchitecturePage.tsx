/** The architecture dashboard: index, Rulings, appeals, and local entries of one Workspace. */
import { useMemo, useState, type ReactNode } from 'react'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconLoadingOutlineRegular,
  IconSearchOutlineRegular,
  Input,
  MarkdownText,
  Menu,
  PathLabel,
  SegmentedControl,
  SegmentedTabs,
  Tag,
  relativeTime,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {
  Adjudication,
  AppealId,
  AppealRecord,
  ArchitectureSectionValue,
  ArchitectureSnapshot,
  GitFileStatus,
  IndexedSection,
  RulingId,
  RulingRecord,
  RulingStatus,
} from '@deepseek-ai/dsh-experimental-api-architecture/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ArchitectureKey } from './locales.ts'
import type { ArchitectModelForm } from './architect-model.ts'
import type { DashboardState } from './dashboard-source.ts'
import { counted } from './counted.ts'
import { Fold } from './Fold.tsx'
import { pendingEdits, ProposedEdits } from './ProposedEdits.tsx'
import { shortRulingId, ToReview } from './ToReview.tsx'
import { SettingsView } from './SettingsView.tsx'
import { SourceList, STATUS_TONE, type SourceScope } from './SourceList.tsx'
import { Overview, type OverviewFigure } from './Overview.tsx'
import css from './ArchitecturePage.module.css'

/** One Workspace the user may pick. */
export interface WorkspaceChoice {
  readonly workspaceId: WorkspaceId
  readonly title: string
}

/** Injected state and actions of the dashboard page. */
export interface ArchitecturePageInjected {
  readonly hooks: {
    readonly architectureDashboard: HostObservable<DashboardState>
    readonly architectureWorkspaces: HostObservable<readonly WorkspaceChoice[]>
  }
  /** Follow another Workspace. */
  readonly selectWorkspace: (workspaceId: WorkspaceId) => void
  /** Open a new Architecture Session in the selected Workspace; resolves false when it could not open. */
  readonly discuss: (workspaceId: WorkspaceId) => Promise<boolean>
  /** Read one section's current text. */
  readonly readSection: (workspaceId: WorkspaceId, path: string, anchor: string) => Promise<ArchitectureSectionValue | undefined>
  /** Accept one section at the hash the user reviewed; resolves false on failure. */
  readonly accept: (workspaceId: WorkspaceId, section: ArchitectureSectionValue) => Promise<boolean>
  /** Decide one appeal; resolves false on failure. */
  readonly adjudicate: (workspaceId: WorkspaceId, appealId: AppealId, adjudication: Adjudication) => Promise<boolean>
  /** Apply one proposed edit of a Ruling; resolves to the failure message, or undefined once written. */
  readonly applyProposedEdit: (workspaceId: WorkspaceId, rulingId: RulingId, index: number, accept: boolean) => Promise<string | undefined>
  /** Dismiss one proposed edit of a Ruling; resolves to the failure message, or undefined once recorded. */
  readonly dismissProposedEdit: (workspaceId: WorkspaceId, rulingId: RulingId, index: number) => Promise<string | undefined>
  /** Declare the main branch in the manifest; resolves to the failure message, or undefined once written. */
  readonly setMainBranch: (workspaceId: WorkspaceId, branch: string) => Promise<string | undefined>
  /** The profile's architect-model form; undefined when the client has no settings service. */
  readonly architectModel: ArchitectModelForm | undefined
}

/** Props of the `main` panel. */
export type ArchitecturePageProps = PropsRuntime<'main'> & InjectFace<ArchitecturePageInjected> & PropsLocale<'architecture'>

type Translate = ArchitecturePageProps['t']
type View = 'architecture' | 'consultations' | 'appeals' | 'local' | 'settings'

const DECISIONS = ['uphold', 'overturn', 'exception'] as const

const RULING_TONE: Readonly<Record<RulingStatus, TagTone>> = {
  issued: 'outline',
  appealed: 'warning',
  upheld: 'success',
  overturned: 'danger',
  excepted: 'info',
}

/**
 * Render the dashboard of the selected Workspace.
 * @param props - dashboard state, Workspace choices, actions, and copy.
 * @returns the page.
 */
export function ArchitecturePage(props: ArchitecturePageProps): ReactNode {
  const { useArchitectureDashboard, useArchitectureWorkspaces, selectWorkspace, discuss, t } = props
  const dashboard = useArchitectureDashboard(state => state)
  const workspaces = useArchitectureWorkspaces(list => list)
  const [view, setView] = useState<View>('architecture')
  // An overview figure opens its view with the filter that lists what it counted; each opening remounts the view.
  const [opening, setOpening] = useState<{ readonly figure: OverviewFigure['key'] | undefined; readonly serial: number }>({ figure: undefined, serial: 0 })
  const choose = (next: View): void => {
    setView(next)
    setOpening(current => ({ figure: undefined, serial: current.serial + 1 }))
  }
  const [discussFailed, setDiscussFailed] = useState(false)
  const { workspaceId, snapshot, error } = dashboard
  // Relative times are read against the snapshot's arrival; each change re-renders them.
  const now = useMemo(() => Date.now(), [snapshot])
  const tabs = [
    { value: 'architecture', label: t('tab.architecture'), id: 'architecture-tab-architecture', panelId: 'architecture-panel' },
    {
      value: 'consultations',
      label: pendingEditCount(snapshot) === 0 ? t('tab.consultations') : `${t('tab.consultations')} · ${String(pendingEditCount(snapshot))}`,
      id: 'architecture-tab-consultations',
      panelId: 'architecture-panel',
    },
    {
      value: 'appeals',
      label: pendingCount(snapshot) === 0 ? t('tab.appeals') : `${t('tab.appeals')} · ${String(pendingCount(snapshot))}`,
      id: 'architecture-tab-appeals',
      panelId: 'architecture-panel',
    },
    { value: 'local', label: t('tab.local'), id: 'architecture-tab-local', panelId: 'architecture-panel' },
    { value: 'settings', label: t('tab.settings'), id: 'architecture-tab-settings', panelId: 'architecture-panel' },
  ] as const
  return (
    <div className={css.page}>
      <div className={css.pageScroll}>
        <div className={css.pageContent}>
          <header className={css.pageHeading}>
            <h1>{t('title')}</h1>
            {workspaces.length > 0 && (
              <WorkspacePicker workspaces={workspaces} workspaceId={workspaceId} selectWorkspace={selectWorkspace} t={t} />
            )}
            {workspaceId !== null && snapshot?.unsupported === undefined && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setDiscussFailed(false)
                  void discuss(workspaceId).then((opened) => { setDiscussFailed(!opened) })
                }}
              >
                {t('discuss')}
              </Button>
            )}
          </header>
          {discussFailed && <p className={css.notice} role="alert">{t('discuss.failed')}</p>}
          {workspaces.length === 0
            ? <p className={css.empty}>{t('workspace.empty')}</p>
            : workspaceId === null
              ? <p className={css.empty}>{t('workspace.none')}</p>
              : (
                <>
                  {error !== null && <p className={css.notice} role="alert">{t('error', { message: error })}</p>}
                  {snapshot === null
                    ? error === null && <div className={css.loading} role="status" aria-label={t('section.loading')}><IconLoadingOutlineRegular className={css.spinner} /></div>
                    : snapshot.unsupported !== undefined
                      ? <Unsupported unsupported={snapshot.unsupported} t={t} />
                      : (
                        <>
                          <Summary snapshot={snapshot} t={t} />
                          {snapshot.hasManifest && (
                            <Overview
                              snapshot={snapshot}
                              open={(target, figure) => {
                                setView(target)
                                setOpening(current => ({ figure, serial: current.serial + 1 }))
                              }}
                              t={t}
                            />
                          )}
                          <SegmentedTabs items={tabs} value={view} onChange={choose} label={t('tabs.label')} />
                          <section
                            key={opening.serial}
                            id="architecture-panel"
                            role="tabpanel"
                            aria-labelledby={`architecture-tab-${view}`}
                            className={css.panel}
                          >
                            {view === 'architecture' && (
                              <IndexView
                                {...props}
                                workspaceId={workspaceId}
                                snapshot={snapshot}
                                initialScope={opening.figure === 'uncommitted' ? 'uncommitted' : 'all'}
                              />
                            )}
                            {view === 'consultations' && (
                              <RulingsView
                                {...props}
                                workspaceId={workspaceId}
                                snapshot={snapshot}
                                now={now}
                                initialFilter={opening.figure === 'stale' ? 'stale' : 'all'}
                              />
                            )}
                            {view === 'appeals' && <AppealsView {...props} workspaceId={workspaceId} snapshot={snapshot} now={now} />}
                            {view === 'local' && <LocalView snapshot={snapshot} t={t} />}
                            {view === 'settings' && (
                              <SettingsView
                                workspaceId={workspaceId}
                                snapshot={snapshot}
                                setMainBranch={props.setMainBranch}
                                architectModel={props.architectModel}
                                t={t}
                              />
                            )}
                          </section>
                        </>
                      )}
                </>
              )}
        </div>
      </div>
    </div>
  )
}

function WorkspacePicker({ workspaces, workspaceId, selectWorkspace, t }: {
  workspaces: readonly WorkspaceChoice[]
  workspaceId: WorkspaceId | null
  selectWorkspace: (workspaceId: WorkspaceId) => void
  t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const current = workspaces.find(choice => choice.workspaceId === workspaceId)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={workspaces.map(choice => ({ id: choice.workspaceId, label: choice.title }))}
      selectedId={workspaceId ?? undefined}
      onSelect={(id) => {
        setOpen(false)
        const choice = workspaces.find(entry => entry.workspaceId === id)
        /* v8 ignore next -- the menu lists only these choices. */
        if (choice === undefined) throw new Error(`architecture: unknown workspace ${id}`)
        selectWorkspace(choice.workspaceId)
      }}
      align="end"
      portal
      anchor={(
        <Button
          size="sm"
          variant="outline"
          aria-label={t('workspace.label')}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          {current?.title ?? t('workspace.choose')}
          <IconChevronDownOutlineRegular />
        </Button>
      )}
    />
  )
}

/**
 * Localize an epoch time in the Workspace sidebar's hover-card form ("now", "5min ago").
 * @param t - the dashboard copy.
 * @param at - epoch ms.
 * @param now - current epoch ms.
 * @returns the label.
 */
function ago(t: Translate, at: number, now: number): string {
  const { unit, n } = relativeTime(at, now)
  return unit === 'now' ? t('time.now') : t('time.ago', { t: t(`time.${unit}`, { n: String(n) }) })
}

/** Git state of an indexed source; the snapshot lists every indexed source. */
function sourceStatus(snapshot: ArchitectureSnapshot, path: string): GitFileStatus {
  const status = snapshot.sourceStatus[path]
  /* v8 ignore next -- the Host reports a status for every indexed source. */
  if (status === undefined) throw new Error(`architecture: no git status for ${path}`)
  return status
}

function pendingEditCount(snapshot: ArchitectureSnapshot | null): number {
  if (snapshot === null) return 0
  return snapshot.rulings.reduce((sum, record) => sum + pendingEdits(snapshot, record), 0)
}

function pendingCount(snapshot: ArchitectureSnapshot | null): number {
  return snapshot?.appeals.filter(appeal => appeal.adjudication === undefined).length ?? 0
}

function Unsupported({ unsupported, t }: { unsupported: NonNullable<ArchitectureSnapshot['unsupported']>; t: Translate }): ReactNode {
  return (
    <p className={css.empty}>
      {unsupported.kind === 'no-repository' ? t('unsupported.noRepository') : t('unsupported.vcsMissing', { vcs: unsupported.vcs })}
    </p>
  )
}

function Summary({ snapshot, t }: { snapshot: ArchitectureSnapshot; t: Translate }): ReactNode {
  const counts = {
    sources: counted(t, 'count.sources', snapshot.index.sources.length),
    sections: counted(t, 'count.sections', snapshot.index.sections.length),
    revision: snapshot.revision,
  }
  return (
    <p className={css.summary}>
      {/* With a manifest the overview carries the counts, so the line keeps only the branch and revision. */}
      {snapshot.hasManifest
        ? snapshot.mainBranch === undefined
          ? t('summary.short.noBranch', counts)
          : t('summary.short', { branch: snapshot.mainBranch, ...counts })
        : snapshot.mainBranch === undefined ? t('summary.noBranch', counts) : t('summary', { branch: snapshot.mainBranch, ...counts })}
      {snapshot.problems.length > 0 && <Tag tone="danger" className={css.inlineTag}>{counted(t, 'problems', snapshot.problems.length)}</Tag>}
      {!snapshot.fresh && (
        <span className={css.refreshing} role="status">
          <IconLoadingOutlineRegular className={css.spinner} aria-hidden />
          {t('summary.refreshing')}
        </span>
      )}
    </p>
  )
}

/** The section shown in the reader: loading, read, or failed. */
interface OpenSection {
  readonly cite: string
  readonly value?: ArchitectureSectionValue
  readonly failed?: boolean
}

type WorkspaceViewProps = ArchitecturePageProps & { readonly workspaceId: WorkspaceId; readonly snapshot: ArchitectureSnapshot }

type IndexViewProps = WorkspaceViewProps & { readonly initialScope: SourceScope }

function IndexView({ workspaceId, snapshot, readSection, accept, initialScope, t }: IndexViewProps): ReactNode {
  const [open, setOpen] = useState<OpenSection | null>(null)
  const [acceptFailed, setAcceptFailed] = useState(false)
  const accepted = useMemo(
    () => new Set(snapshot.acceptances.map(entry => `${entry.path}#${entry.anchor}@${entry.hash}`)),
    [snapshot.acceptances],
  )
  if (!snapshot.hasManifest) return <p className={css.empty}>{t('noManifest', { manifest: snapshot.manifestPath })}</p>
  const show = (section: IndexedSection): void => {
    const cite = `${section.path}#${section.anchor}`
    setOpen({ cite })
    setAcceptFailed(false)
    void readSection(workspaceId, section.path, section.anchor).then((value) => {
      setOpen(current => current?.cite !== cite ? current : value === undefined ? { cite, failed: true } : { cite, value })
    })
  }
  return (
    <div className={css.split}>
      <div className={css.list}>
        {snapshot.mainBranch === undefined && <p className={css.notice}>{t('noBranch', { manifest: snapshot.manifestPath })}</p>}
        {snapshot.index.diagnostics.length > 0 && (
          <p className={css.notice}>{counted(t, 'diagnostics', snapshot.index.diagnostics.length)}</p>
        )}
        <SourceList snapshot={snapshot} openCite={open?.cite} show={show} initialScope={initialScope} t={t} />
      </div>
      {open === null && <p className={css.readerEmpty}>{t('section.pick')}</p>}
      {open !== null && (
        <article className={css.reader} aria-label={open.cite}>
          <header className={css.readerHeading}>
            <PathLabel className={css.path} path={open.cite} />
            <Button size="sm" onClick={() => { setOpen(null) }}>{t('section.close')}</Button>
          </header>
          {open.failed === true
            ? <p className={css.notice} role="alert">{t('section.failed')}</p>
            : open.value === undefined
              ? <div className={css.loading} role="status" aria-label={t('section.loading')}><IconLoadingOutlineRegular className={css.spinner} /></div>
              : ((value: ArchitectureSectionValue) => (
                <>
                  <SectionText text={value.text} t={t} />
                  {sourceStatus(snapshot, value.path) !== 'committed' && (
                    <footer className={css.readerFooter}>
                      {accepted.has(`${value.path}#${value.anchor}@${value.hash}`)
                        ? <Tag tone="success">{t('section.accepted')}</Tag>
                        : (
                          <>
                            <span className={css.meta}>{t('section.acceptHint')}</span>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!snapshot.fresh}
                              onClick={() => { void accept(workspaceId, value).then((ok) => { setAcceptFailed(!ok) }) }}
                            >
                              {t('section.accept')}
                            </Button>
                          </>
                        )}
                      {acceptFailed && <p className={css.notice} role="alert">{t('section.acceptFailed')}</p>}
                    </footer>
                  )}
                </>
              ))(open.value)}
        </article>
      )}
    </div>
  )
}

function SectionText({ text, t }: { text: string; t: Translate }): ReactNode {
  const labels = useMemo(() => ({
    code: {
      copyLabel: t('markdown.copy'),
      copiedLabel: t('markdown.copied'),
      toolbarLabels: { codeLabel: t('markdown.codeBlock'), wrapLabel: t('markdown.wrap'), unwrapLabel: t('markdown.unwrap') },
    },
    footnotes: t('markdown.footnotes'),
  }), [t])
  return <div className={css.document}><MarkdownText text={text} labels={labels} /></div>
}

const RULING_FILTERS = ['all', 'stale', 'appealed'] as const
type RulingFilter = typeof RULING_FILTERS[number]

function RulingsView(props: WorkspaceViewProps & { readonly now: number; readonly initialFilter: RulingFilter }): ReactNode {
  const { snapshot, initialFilter, t } = props
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<RulingFilter>(initialFilter)
  if (snapshot.rulings.length === 0) return <p className={css.empty}>{t('consultations.empty')}</p>
  const needle = query.trim().toLowerCase()
  const kept = snapshot.rulings.filter(record => filter === 'all'
    || (filter === 'stale' ? record.stale : record.status === 'appealed'))
  // The search reads the question, the Ruling id, and the sections a Ruling cites or proposes to change.
  const shown = needle === '' ? kept : kept.filter(({ ruling }) => [
    ruling.question,
    ruling.id,
    ...ruling.constraints.flatMap(constraint => constraint.citations.map(citation => `${citation.path}#${citation.anchor}`)),
    ...ruling.proposedEdits.map(edit => `${edit.path}#${edit.anchor}`),
  ].some(text => text.toLowerCase().includes(needle)))
  return (
    <>
      <ToReview {...props} />
      <h2 className={css.reviewHeading}>
        {t('history.title')}
        <span className={css.meta}>{counted(t, 'history.count', snapshot.rulings.length)}</span>
      </h2>
      <div className={css.filters}>
        <Input
          className={css.search as string}
          icon={<IconSearchOutlineRegular />}
          type="search"
          aria-label={t('history.search')}
          placeholder={t('history.search')}
          value={query}
          onChange={(event) => { setQuery(event.target.value) }}
        />
        <SegmentedControl
          id="architecture-ruling-filter"
          value={filter}
          options={RULING_FILTERS.map(option => ({
            value: option,
            label: option === 'all'
              ? t('history.filter.all')
              : `${t(`history.filter.${option}`)} · ${String(snapshot.rulings.filter(record => option === 'stale' ? record.stale : record.status === 'appealed').length)}`,
          }))}
          onChange={setFilter}
          label={t('history.filter')}
        />
      </div>
      {shown.length === 0
        ? <p className={css.empty}>{t('history.noMatch')}</p>
        : (
          <div className={css.tableFrame}>
            <ul className={css.table} aria-label={t('history.title')}>
              {shown.map(record => <RulingCard key={record.ruling.id} {...props} record={record} />)}
            </ul>
          </div>
        )}
    </>
  )
}

type RulingCardProps = WorkspaceViewProps & { readonly record: RulingRecord & { readonly stale: boolean }; readonly now: number }

function RulingCard(props: RulingCardProps): ReactNode {
  const { record, now, t } = props
  const { ruling } = record
  const pending = pendingEdits(props.snapshot, record)
  const counts = [
    counted(t, 'ruling.count.constraints', ruling.constraints.length),
    ...ruling.unresolved.length === 0 ? [] : [t('ruling.count.unresolved', { count: String(ruling.unresolved.length) })],
    ...ruling.proposedEdits.length === 0 || pending > 0 ? [] : [counted(t, 'ruling.count.proposedEdits', ruling.proposedEdits.length)],
  ]
  // Every edit was decided by the user, by applying or dismissing it.
  const allDecided = ruling.proposedEdits.length > 0
    && ruling.proposedEdits.every((_, index) => record.appliedEdits.includes(index) || record.dismissedEdits.includes(index))
  return (
    <li className={css.tableRow}>
      <Fold
        variant="card"
        heading={ruling.question}
        defaultOpen={false}
        aside={(
          <>
            <span className={css.tags}>
              {pending > 0 && <Tag tone="warning">{counted(t, 'ruling.pendingEdits', pending)}</Tag>}
              {record.stale && <Tag tone="warning">{t('ruling.stale')}</Tag>}
              {record.status !== 'issued' && <Tag tone={RULING_TONE[record.status]}>{t(`ruling.status.${record.status}`)}</Tag>}
              {allDecided && <Tag tone="success">{t('ruling.allDecided')}</Tag>}
            </span>
            <span className={css.counts}>{counts.join(' · ')}</span>
            <span className={css.rulingId}>{shortRulingId(ruling.id)}</span>
            <time className={css.age} dateTime={new Date(record.issuedAt).toISOString()}>{ago(t, record.issuedAt, now)}</time>
          </>
        )}
      >
        <p className={css.fullQuestion}>{ruling.question}</p>
        <p className={css.meta}>
          {ruling.id} · {t('ruling.meta', { time: ago(t, record.issuedAt, now), session: record.workerSession })}
        </p>
        {ruling.summary !== '' && (
          <Fold variant="section" heading={t('ruling.summary')} defaultOpen>
            <p>{ruling.summary}</p>
          </Fold>
        )}
        <Fold variant="section" heading={t('ruling.constraints')} defaultOpen>
          {ruling.constraints.length === 0
            ? <p className={css.meta}>{t('ruling.noConstraints')}</p>
            : (
              <ol className={css.constraints}>
                {ruling.constraints.map(constraint => (
                  <li key={constraint.statement}>
                    {constraint.statement}
                    <span className={css.cites}>{constraint.citations.map(citation => `${citation.path}#${citation.anchor}`).join(', ')}</span>
                  </li>
                ))}
              </ol>
            )}
        </Fold>
        {ruling.unresolved.length > 0 && (
          <Fold variant="section" heading={t('ruling.unresolved')} defaultOpen={false} aside={<span className={css.meta}>{String(ruling.unresolved.length)}</span>}>
            <ul className={css.constraints}>
              {ruling.unresolved.map(point => (
                <li key={point.statement}>
                  {point.statement}
                  {point.reason !== undefined && <span className={css.cites}>{point.reason}</span>}
                </li>
              ))}
            </ul>
          </Fold>
        )}
        <ProposedEdits {...props} />
      </Fold>
    </li>
  )
}

function AppealsView({ workspaceId, snapshot, now, adjudicate, t }: WorkspaceViewProps & { readonly now: number }): ReactNode {
  if (snapshot.appeals.length === 0) return <p className={css.empty}>{t('appeals.empty')}</p>
  return (
    <ul className={css.cards}>
      {snapshot.appeals.map(appeal => (
        <AppealCard
          key={appeal.id}
          appeal={appeal}
          question={snapshot.rulings.find(record => record.ruling.id === appeal.rulingId)?.ruling.question}
          decide={adjudication => adjudicate(workspaceId, appeal.id, adjudication)}
          stale={!snapshot.fresh}
          now={now}
          t={t}
        />
      ))}
    </ul>
  )
}

function AppealCard({ appeal, question, decide, stale, now, t }: {
  appeal: AppealRecord
  question: string | undefined
  decide: (adjudication: Adjudication) => Promise<boolean>
  /** The snapshot may predate a decision, so the form waits for a fresh one. */
  stale: boolean
  now: number
  t: Translate
}): ReactNode {
  const [kind, setKind] = useState<Adjudication['kind']>('uphold')
  const [scope, setScope] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setBusy] = useState(false)
  const busy = submitting || stale
  const [failed, setFailed] = useState(false)
  const decided = appeal.adjudication
  const submit = (): void => {
    const trimmedNote = note.trim()
    const noteField = trimmedNote === '' ? {} : { note: trimmedNote }
    const adjudication: Adjudication = kind === 'exception' ? { kind, scope: scope.trim(), ...noteField } : { kind, ...noteField }
    setBusy(true)
    setFailed(false)
    void decide(adjudication).then((ok) => { setBusy(false); setFailed(!ok) })
  }
  return (
    <li className={css.card}>
      <Fold
        variant="card"
        heading={question ?? appeal.rulingId}
        defaultOpen={decided === undefined}
        aside={decided === undefined
          ? <Tag tone="warning">{t('appeal.pending')}</Tag>
          : <Tag tone="info">{decided.kind === 'exception' ? t('appeal.decided.exception', { scope: decided.scope }) : t(`appeal.decided.${decided.kind}`)}</Tag>}
      >
        <p className={css.meta}>{t('appeal.ruling', { ruling: appeal.rulingId })} · {ago(t, appeal.filedAt, now)}</p>
        <h3 className={css.subheading}>{t('appeal.reason')}</h3>
        <p>{appeal.reason}</p>
        {appeal.evidence.length > 0 && (
          <>
            <h3 className={css.subheading}>{t('appeal.evidence')}</h3>
            <ul className={css.constraints}>{appeal.evidence.map(item => <li key={item}>{item}</li>)}</ul>
          </>
        )}
        {decided !== undefined
          ? (
            <p className={css.meta}>
              {decided.note !== undefined && `${decided.note} · `}
              {appeal.delivered ? t('appeal.delivered') : t('appeal.undelivered')}
            </p>
          )
          : (
            <div className={css.decision}>
              <SegmentedControl
                id={`decision-${appeal.id}`}
                value={kind}
                options={DECISIONS.map(option => ({ value: option, label: t(`appeal.${option}`) }))}
                onChange={setKind}
                label={t('appeal.decision')}
                disabled={busy}
              />
              {kind === 'exception' && (
                <Input
                  className={css.decisionField as string}
                  aria-label={t('appeal.exceptionScope')}
                  placeholder={t('appeal.exceptionPlaceholder')}
                  disabled={busy}
                  value={scope}
                  onChange={(event) => { setScope(event.target.value) }}
                />
              )}
              <Input
                className={css.decisionField as string}
                aria-label={t('appeal.note')}
                placeholder={t('appeal.note')}
                disabled={busy}
                value={note}
                onChange={(event) => { setNote(event.target.value) }}
              />
              <Button variant="primary" size="sm" disabled={busy || (kind === 'exception' && scope.trim() === '')} onClick={submit}>
                {t('appeal.submit')}
              </Button>
              {failed && <p className={css.notice} role="alert">{t('appeal.failed')}</p>}
            </div>
          )}
      </Fold>
    </li>
  )
}

function LocalView({ snapshot, t }: { snapshot: ArchitectureSnapshot; t: Translate }): ReactNode {
  return (
    <>
      <p className={css.meta}>{t('local.hint')}</p>
      {snapshot.localEntries.length === 0
        ? <p className={css.empty}>{t('local.empty', { directory: snapshot.localDirectory })}</p>
        : (
          <ul className={css.cards}>
            {snapshot.localEntries.map(entry => (
              <li key={entry.path} className={css.row}>
                <PathLabel className={css.path} path={entry.path} />
                <Tag tone={STATUS_TONE[entry.status]}>{t(`status.${entry.status}`)}</Tag>
              </li>
            ))}
          </ul>
        )}
    </>
  )
}

/** Key domain re-exported for the slot declaration. */
export type { ArchitectureKey }
