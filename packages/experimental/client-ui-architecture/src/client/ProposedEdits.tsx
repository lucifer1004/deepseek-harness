/**
 * The proposed edits of one Ruling: each shows the architect's text against the section as it stands, and the user
 * applies it, with or without accepting the written section.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, DiffBlock, Tag, type DiffBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArchitectureSectionValue, ArchitectureSnapshot, ProposedEdit, RulingId, RulingRecord } from '@deepseek-ai/dsh-experimental-api-architecture/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { Translate } from './SettingsView.tsx'
import css from './ArchitecturePage.module.css'

/** Actions the proposed-edit list needs from the page. */
export interface ProposedEditActions {
  /** Read one section's current text. */
  readonly readSection: (workspaceId: WorkspaceId, path: string, anchor: string) => Promise<ArchitectureSectionValue | undefined>
  /** Apply one proposed edit; resolves to the failure message, or undefined once written. */
  readonly applyProposedEdit: (workspaceId: WorkspaceId, rulingId: RulingId, index: number, accept: boolean) => Promise<string | undefined>
}

/** Props of {@link ProposedEdits}. */
export interface ProposedEditsProps extends ProposedEditActions {
  readonly workspaceId: WorkspaceId
  readonly snapshot: ArchitectureSnapshot
  readonly record: RulingRecord
  readonly t: Translate
}

/**
 * Render a Ruling's proposed edits.
 * @param props - the Ruling, its repository, the actions, and copy.
 * @returns the list, or nothing when the Ruling proposes no edit.
 */
export function ProposedEdits(props: ProposedEditsProps): ReactNode {
  const { record, t } = props
  if (record.ruling.proposedEdits.length === 0) return null
  return (
    <>
      <h3 className={css.subheading}>{t('ruling.proposedEdits')}</h3>
      <p className={css.meta}>{t('ruling.proposedEdits.hint')}</p>
      <ul className={css.proposals}>
        {record.ruling.proposedEdits.map((edit, index) => (
          <ProposedEditItem key={`${edit.path}#${edit.anchor}`} {...props} edit={edit} index={index} applied={record.appliedEdits.includes(index)} />
        ))}
      </ul>
    </>
  )
}

type CurrentText = { readonly kind: 'loading' } | { readonly kind: 'text'; readonly text: string } | { readonly kind: 'gone' }

type ProposedEditItemProps = ProposedEditsProps & { readonly edit: ProposedEdit; readonly index: number; readonly applied: boolean }

function ProposedEditItem(props: ProposedEditItemProps): ReactNode {
  const { workspaceId, snapshot, record, edit, index, applied, readSection, applyProposedEdit, t } = props
  const cite = `${edit.path}#${edit.anchor}`
  const section = snapshot.index.sections.find(entry => entry.path === edit.path && entry.anchor === edit.anchor)
  // The architect read the section at `edit.hash`; any other current hash means applying would be refused.
  const changed = !applied && section?.hash !== edit.hash
  const [current, setCurrent] = useState<CurrentText>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (applied || changed) return
    let live = true
    void readSection(workspaceId, edit.path, edit.anchor).then((value) => {
      if (live) setCurrent(value === undefined ? { kind: 'gone' } : { kind: 'text', text: value.text })
    })
    return () => { live = false }
  }, [workspaceId, edit.path, edit.anchor, applied, changed, readSection])
  const labels = useMemo<DiffBlockLabels>(() => ({
    copy: t('markdown.copy'),
    copied: t('markdown.copied'),
    codeLabel: t('markdown.codeBlock'),
    wrapLabel: t('markdown.wrap'),
    unwrapLabel: t('markdown.unwrap'),
    collapseAria: t('diff.collapse'),
    expandAria: hidden => t('diff.expandAria', { count: String(hidden) }),
    collapse: t('diff.collapse'),
    expand: hidden => t('diff.expand', { count: String(hidden) }),
  }), [t])
  const apply = (accept: boolean): void => {
    setBusy(true)
    setFailure(undefined)
    void applyProposedEdit(workspaceId, record.ruling.id, index, accept).then((message) => {
      setBusy(false)
      setFailure(message)
    })
  }
  return (
    <li className={css.proposal}>
      <header className={css.cardHeading}>
        <span className={css.cites}>{cite}</span>
        {applied && <Tag tone="success">{t('ruling.proposedEdit.applied')}</Tag>}
        {changed && <Tag tone="warning">{t('ruling.proposedEdit.changed')}</Tag>}
      </header>
      <p>{edit.rationale}</p>
      {applied
        ? null
        : changed
          ? <p className={css.meta}>{t('ruling.proposedEdit.changedHint')}</p>
          : current.kind === 'loading'
            ? <p className={css.meta} role="status">{t('section.loading')}</p>
            : current.kind === 'gone'
              ? <p className={css.notice} role="alert">{t('section.failed')}</p>
              : (
                <>
                  <DiffBlock diffs={[{ path: cite, oldText: current.text, newText: edit.content }]} labels={labels} />
                  <footer className={css.readerFooter}>
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => { apply(true) }}>{t('ruling.proposedEdit.applyAccept')}</Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => { apply(false) }}>{t('ruling.proposedEdit.apply')}</Button>
                  </footer>
                </>
              )}
      {failure !== undefined && <p className={css.notice} role="alert">{t('ruling.proposedEdit.failed', { message: failure })}</p>}
    </li>
  )
}
