/**
 * The indexed sources of a repository, grouped by directory, with a filter over paths and section titles and a
 * filter for sources that are not committed.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { DisclosureRow, FileTypeIcon, IconSearchOutlineRegular, Input, SegmentedControl, Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArchitectureSnapshot, GitFileStatus, IndexedSection } from '@deepseek-ai/dsh-experimental-api-architecture/types'
import type { Translate } from './SettingsView.tsx'
import { counted } from './counted.ts'
import css from './ArchitecturePage.module.css'

/** Tag tone of each git status of a file. */
export const STATUS_TONE: Readonly<Record<GitFileStatus, TagTone>> = {
  committed: 'quiet',
  modified: 'warning',
  untracked: 'info',
  ignored: 'neutral',
}

/** Up to this many sources, every directory starts open. */
const OPEN_DIRECTORIES_UP_TO = 12

const SCOPES = ['all', 'uncommitted'] as const
/** Which sources the list shows. */
export type SourceScope = typeof SCOPES[number]

/** Props of {@link SourceList}. */
export interface SourceListProps {
  readonly snapshot: ArchitectureSnapshot
  /** Cite of the section in the reader, if any. */
  readonly openCite: string | undefined
  readonly show: (section: IndexedSection) => void
  /** The scope the list opens with. */
  readonly initialScope?: SourceScope
  readonly t: Translate
}

interface SourceEntry {
  readonly path: string
  readonly name: string
  readonly status: GitFileStatus
  /** All sections of the source. */
  readonly sections: readonly IndexedSection[]
  /** The sections the query matched; all of them when the path matched or there is no query. */
  readonly shown: readonly IndexedSection[]
}

/**
 * Render the source list.
 * @param props - the snapshot, the open section, the action that opens one, and copy.
 * @returns the filter controls and the grouped sources.
 */
export function SourceList({ snapshot, openCite, show, initialScope = 'all', t }: SourceListProps): ReactNode {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<SourceScope>(initialScope)
  // Directories and sources the user toggled away from their default state.
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set())
  const flip = (key: string): void => {
    setToggled((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }
  const accepted = useMemo(
    () => new Set(snapshot.acceptances.map(entry => `${entry.path}#${entry.anchor}@${entry.hash}`)),
    [snapshot.acceptances],
  )
  const bySource = useMemo(() => {
    const groups = new Map<string, IndexedSection[]>()
    for (const section of snapshot.index.sections) groups.set(section.path, [...groups.get(section.path) ?? [], section])
    return groups
  }, [snapshot.index.sections])
  const needle = query.trim().toLowerCase()
  const searching = needle !== ''
  const directories = useMemo(() => {
    const result = new Map<string, SourceEntry[]>()
    for (const [path, sections] of bySource) {
      const status = snapshot.sourceStatus[path]
      /* v8 ignore next -- the Host reports a status for every indexed source. */
      if (status === undefined) throw new Error(`architecture: no git status for ${path}`)
      if (scope === 'uncommitted' && status === 'committed') continue
      const pathMatches = path.toLowerCase().includes(needle)
      const shown = pathMatches
        ? sections
        : sections.filter(section => section.title.toLowerCase().includes(needle) || section.anchor.includes(needle))
      if (shown.length === 0) continue
      const slash = path.lastIndexOf('/')
      const directory = slash === -1 ? '' : path.slice(0, slash + 1)
      result.set(directory, [...result.get(directory) ?? [], { path, name: path.slice(slash + 1), status, sections, shown }])
    }
    return [...result].sort(([a], [b]) => a.localeCompare(b))
  }, [bySource, snapshot.sourceStatus, scope, needle])
  const sourceCount = directories.reduce((sum, [, entries]) => sum + entries.length, 0)
  const sectionCount = directories.reduce((sum, [, entries]) => sum + entries.reduce((inner, entry) => inner + entry.shown.length, 0), 0)
  // Few sources open every directory; a query opens what it matched. Toggling inverts the default.
  const directoryOpen = (directory: string): boolean =>
    (searching || bySource.size <= OPEN_DIRECTORIES_UP_TO) !== toggled.has(`dir:${directory}`)
  const sourceOpen = (path: string): boolean => searching !== toggled.has(`src:${path}`)
  return (
    <>
      <div className={css.filters}>
        <Input
          className={css.search as string}
          icon={<IconSearchOutlineRegular />}
          type="search"
          aria-label={t('index.search')}
          placeholder={t('index.search')}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setToggled(new Set()) }}
        />
        <SegmentedControl
          id="architecture-source-scope"
          value={scope}
          options={SCOPES.map(option => ({ value: option, label: t(`index.scope.${option}`) }))}
          onChange={setScope}
          label={t('index.scope')}
        />
      </div>
      <p className={css.meta}>{t('index.count', { sources: counted(t, 'count.sources', sourceCount), sections: counted(t, 'count.sections', sectionCount) })}</p>
      {directories.length === 0 && <p className={css.empty}>{t('index.noMatch')}</p>}
      {directories.map(([directory, entries]) => (
        <DisclosureRow
          key={directory}
          className={css.directory}
          contentLayoutClassName={css.sourceHeading}
          icon={<FileTypeIcon kind="folder" size={16} />}
          title={directory === '' ? t('index.root') : directory}
          open={directoryOpen(directory)}
          expandable
          expandOnRowClick
          keepContentWhenOpen
          onToggle={() => { flip(`dir:${directory}`) }}
          collapsedContent={<span className={css.meta}>{String(entries.length)}</span>}
        >
          <div className={css.directorySources}>
            {entries.map(entry => (
              <DisclosureRow
                key={entry.path}
                className={css.source}
                contentLayoutClassName={css.sourceHeading}
                icon={<FileTypeIcon path={entry.path} size={16} />}
                title={entry.name}
                open={sourceOpen(entry.path)}
                expandable
                expandOnRowClick
                keepContentWhenOpen
                onToggle={() => { flip(`src:${entry.path}`) }}
                collapsedContent={(
                  <>
                    {entry.status !== 'committed' && <Tag tone={STATUS_TONE[entry.status]}>{t(`status.${entry.status}`)}</Tag>}
                    <span className={css.meta}>
                      {entry.shown.length === entry.sections.length
                        ? counted(t, 'count.sections', entry.sections.length)
                        : t('source.matched', { count: String(entry.shown.length), total: String(entry.sections.length) })}
                    </span>
                  </>
                )}
              >
                <ul className={css.sections}>
                  {entry.shown.map((section) => {
                    const cite = `${section.path}#${section.anchor}`
                    return (
                      <li key={section.anchor}>
                        <button
                          type="button"
                          className={css.sectionButton}
                          aria-label={t('section.open', { cite })}
                          aria-pressed={openCite === cite}
                          onClick={() => { show(section) }}
                          style={{ paddingInlineStart: `${String((section.level - 1) * 12 + 8)}px` }}
                        >
                          {section.title === '' ? t('section.preamble') : section.title}
                        </button>
                        {accepted.has(`${cite}@${section.hash}`) && <Tag tone="success">{t('status.accepted')}</Tag>}
                      </li>
                    )
                  })}
                </ul>
              </DisclosureRow>
            ))}
          </div>
        </DisclosureRow>
      ))}
    </>
  )
}
