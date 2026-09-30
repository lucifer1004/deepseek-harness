/** The architecture dashboard: index, Rulings, appeals, and local entries of one Workspace. */
import { useMemo, useState, type ReactNode } from 'react'
import { Button, IconLoadingOutlineRegular, Input, MarkdownText, SegmentedTabs, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
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
  RulingRecord,
  RulingStatus,
} from '@deepseek-ai/dsh-experimental-api-architecture/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ArchitectureKey } from './locales.ts'
import type { DashboardState } from './dashboard-source.ts'
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
}

/** Props of the `main` panel. */
export type ArchitecturePageProps = PropsRuntime<'main'> & InjectFace<ArchitecturePageInjected> & PropsLocale<'architecture'>

type Translate = ArchitecturePageProps['t']
type View = 'architecture' | 'consultations' | 'appeals' | 'local'

const STATUS_TONE: Readonly<Record<GitFileStatus, TagTone>> = {
  committed: 'quiet',
  modified: 'warning',
  untracked: 'info',
  ignored: 'neutral',
}

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
  const [discussFailed, setDiscussFailed] = useState(false)
  const { workspaceId, snapshot, error } = dashboard
  const tabs = [
    { value: 'architecture', label: t('tab.architecture'), id: 'architecture-tab-architecture', panelId: 'architecture-panel' },
    { value: 'consultations', label: t('tab.consultations'), id: 'architecture-tab-consultations', panelId: 'architecture-panel' },
    {
      value: 'appeals',
      label: pendingCount(snapshot) === 0 ? t('tab.appeals') : `${t('tab.appeals')} · ${String(pendingCount(snapshot))}`,
      id: 'architecture-tab-appeals',
      panelId: 'architecture-panel',
    },
    { value: 'local', label: t('tab.local'), id: 'architecture-tab-local', panelId: 'architecture-panel' },
  ] as const
  return (
    <div className={css.page}>
      <div className={css.pageScroll}>
        <div className={css.pageContent}>
          <header className={css.pageHeading}>
            <h1>{t('title')}</h1>
            <label className={css.workspace}>
              <span>{t('workspace.label')}</span>
              <select
                value={workspaceId ?? ''}
                onChange={(event) => { if (event.target.value !== '') selectWorkspace(workspaceChoice(workspaces, event.target.value)) }}
              >
                {workspaceId === null && <option value="">{t('workspace.none')}</option>}
                {workspaces.map(choice => <option key={choice.workspaceId} value={choice.workspaceId}>{choice.title}</option>)}
              </select>
            </label>
            {workspaceId !== null && (
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
                    : (
                      <>
                        <Summary snapshot={snapshot} t={t} />
                        <SegmentedTabs items={tabs} value={view} onChange={setView} label={t('tabs.label')} />
                        <section id="architecture-panel" role="tabpanel" aria-labelledby={`architecture-tab-${view}`} className={css.panel}>
                          {view === 'architecture' && <IndexView {...props} workspaceId={workspaceId} snapshot={snapshot} />}
                          {view === 'consultations' && <RulingsView snapshot={snapshot} t={t} />}
                          {view === 'appeals' && <AppealsView {...props} workspaceId={workspaceId} snapshot={snapshot} />}
                          {view === 'local' && <LocalView snapshot={snapshot} t={t} />}
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

function workspaceChoice(workspaces: readonly WorkspaceChoice[], value: string): WorkspaceId {
  const choice = workspaces.find(entry => entry.workspaceId === value)
  /* v8 ignore next -- the select lists only these choices. */
  if (choice === undefined) throw new Error(`architecture: unknown workspace ${value}`)
  return choice.workspaceId
}

/** Git state of an indexed source; the snapshot lists every indexed source. */
function sourceStatus(snapshot: ArchitectureSnapshot, path: string): GitFileStatus {
  const status = snapshot.sourceStatus[path]
  /* v8 ignore next -- the Host reports a status for every indexed source. */
  if (status === undefined) throw new Error(`architecture: no git status for ${path}`)
  return status
}

function pendingCount(snapshot: ArchitectureSnapshot | null): number {
  return snapshot?.appeals.filter(appeal => appeal.adjudication === undefined).length ?? 0
}

function Summary({ snapshot, t }: { snapshot: ArchitectureSnapshot; t: Translate }): ReactNode {
  return (
    <p className={css.summary}>
      {t('summary', {
        branch: snapshot.mainBranch,
        sources: String(snapshot.index.sources.length),
        sections: String(snapshot.index.sections.length),
        revision: snapshot.revision,
      })}
      {snapshot.problems.length > 0 && <Tag tone="danger" className={css.inlineTag}>{t('problems', { count: String(snapshot.problems.length) })}</Tag>}
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

function IndexView({ workspaceId, snapshot, readSection, accept, t }: WorkspaceViewProps): ReactNode {
  const [open, setOpen] = useState<OpenSection | null>(null)
  const [acceptFailed, setAcceptFailed] = useState(false)
  const accepted = useMemo(
    () => new Set(snapshot.acceptances.map(entry => `${entry.path}#${entry.anchor}@${entry.hash}`)),
    [snapshot.acceptances],
  )
  const bySource = useMemo(() => {
    const groups = new Map<string, IndexedSection[]>()
    for (const section of snapshot.index.sections) groups.set(section.path, [...groups.get(section.path) ?? [], section])
    return groups
  }, [snapshot.index.sections])
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
        {snapshot.index.diagnostics.length > 0 && (
          <p className={css.notice}>{t('diagnostics', { count: String(snapshot.index.diagnostics.length) })}</p>
        )}
        {[...bySource].map(([path, sections]) => {
          const status = sourceStatus(snapshot, path)
          return (
            <details key={path} className={css.source}>
              <summary>
                <span className={css.path}>{path}</span>
                <Tag tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Tag>
                <span className={css.meta}>{t('source.sections', { count: String(sections.length) })}</span>
              </summary>
              <ul className={css.sections}>
                {sections.map(section => (
                  <li key={section.anchor}>
                    <button
                      type="button"
                      className={css.sectionButton}
                      aria-label={t('section.open', { cite: `${section.path}#${section.anchor}` })}
                      aria-pressed={open?.cite === `${section.path}#${section.anchor}`}
                      onClick={() => { show(section) }}
                      style={{ paddingInlineStart: `${String((section.level - 1) * 12 + 8)}px` }}
                    >
                      {section.title}
                    </button>
                    {accepted.has(`${section.path}#${section.anchor}@${section.hash}`) && <Tag tone="success">{t('status.accepted')}</Tag>}
                  </li>
                ))}
              </ul>
            </details>
          )
        })}
      </div>
      {open !== null && (
        <article className={css.reader} aria-label={open.cite}>
          <header className={css.readerHeading}>
            <span className={css.path}>{open.cite}</span>
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

function RulingsView({ snapshot, t }: { snapshot: ArchitectureSnapshot; t: Translate }): ReactNode {
  if (snapshot.rulings.length === 0) return <p className={css.empty}>{t('consultations.empty')}</p>
  return <ul className={css.cards}>{snapshot.rulings.map(record => <RulingCard key={record.ruling.id} record={record} t={t} />)}</ul>
}

function RulingCard({ record, t }: { record: RulingRecord & { readonly stale: boolean }; t: Translate }): ReactNode {
  const { ruling } = record
  return (
    <li className={css.card}>
      <header className={css.cardHeading}>
        <span className={css.question}>{ruling.question}</span>
        <Tag tone={RULING_TONE[record.status]}>{t(`ruling.status.${record.status}`)}</Tag>
        {record.stale && <Tag tone="warning">{t('ruling.stale')}</Tag>}
      </header>
      <p className={css.meta}>
        {ruling.id} · {t('ruling.meta', { time: new Date(record.issuedAt).toLocaleString(), session: record.workerSession })}
      </p>
      {ruling.summary !== '' && <p>{ruling.summary}</p>}
      <h3 className={css.subheading}>{t('ruling.constraints')}</h3>
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
      {ruling.unresolved.length > 0 && (
        <>
          <h3 className={css.subheading}>{t('ruling.unresolved')}</h3>
          <ul className={css.constraints}>
            {ruling.unresolved.map(point => (
              <li key={point.statement}>
                {point.statement}
                {point.reason !== undefined && <span className={css.cites}>{point.reason}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </li>
  )
}

function AppealsView({ workspaceId, snapshot, adjudicate, t }: WorkspaceViewProps): ReactNode {
  if (snapshot.appeals.length === 0) return <p className={css.empty}>{t('appeals.empty')}</p>
  return (
    <ul className={css.cards}>
      {snapshot.appeals.map(appeal => (
        <AppealCard
          key={appeal.id}
          appeal={appeal}
          question={snapshot.rulings.find(record => record.ruling.id === appeal.rulingId)?.ruling.question}
          decide={adjudication => adjudicate(workspaceId, appeal.id, adjudication)}
          t={t}
        />
      ))}
    </ul>
  )
}

function AppealCard({ appeal, question, decide, t }: {
  appeal: AppealRecord
  question: string | undefined
  decide: (adjudication: Adjudication) => Promise<boolean>
  t: Translate
}): ReactNode {
  const [kind, setKind] = useState<Adjudication['kind']>('uphold')
  const [scope, setScope] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
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
      <header className={css.cardHeading}>
        <span className={css.question}>{question ?? appeal.rulingId}</span>
        {decided === undefined
          ? <Tag tone="warning">{t('appeal.pending')}</Tag>
          : <Tag tone="info">{decided.kind === 'exception' ? t('appeal.decided.exception', { scope: decided.scope }) : t(`appeal.decided.${decided.kind}`)}</Tag>}
      </header>
      <p className={css.meta}>{t('appeal.ruling', { ruling: appeal.rulingId })} · {new Date(appeal.filedAt).toLocaleString()}</p>
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
          <fieldset className={css.decision} disabled={busy}>
            {(['uphold', 'overturn', 'exception'] as const).map(option => (
              <label key={option} className={css.option}>
                <input type="radio" name={`decision-${appeal.id}`} checked={kind === option} onChange={() => { setKind(option) }} />
                {t(`appeal.${option}`)}
              </label>
            ))}
            {kind === 'exception' && (
              <Input
                aria-label={t('appeal.exceptionScope')}
                placeholder={t('appeal.exceptionPlaceholder')}
                value={scope}
                onChange={(event) => { setScope(event.target.value) }}
              />
            )}
            <Input aria-label={t('appeal.note')} placeholder={t('appeal.note')} value={note} onChange={(event) => { setNote(event.target.value) }} />
            <Button variant="primary" size="sm" disabled={kind === 'exception' && scope.trim() === ''} onClick={submit}>{t('appeal.submit')}</Button>
            {failed && <p className={css.notice} role="alert">{t('appeal.failed')}</p>}
          </fieldset>
        )}
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
                <span className={css.path}>{entry.path}</span>
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
