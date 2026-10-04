/**
 * The proposed edits of one Ruling: each shows the architect's text against the section as it stands, and the user
 * applies it, with or without accepting the written section.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, DiffBlock, Tag, type DiffBlockLabels, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ArchitectureSectionValue, ArchitectureSnapshot, ProposedEdit, RulingId, RulingRecord } from '@deepseek-ai/dsh-experimental-api-architecture/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { Translate } from './SettingsView.tsx'
import { counted } from './counted.ts'
import { Fold } from './Fold.tsx'
import css from './ArchitecturePage.module.css'

/** Where one proposed edit stands: applied, dismissed, open for the user, or blocked by a change to its section. */
export type ProposedEditState = 'applied' | 'dismissed' | 'pending' | 'changed'

/**
 * Classify one proposed edit of a recorded Ruling against the current index.
 * @param snapshot - the repository's current state.
 * @param record - the Ruling that carries the edit.
 * @param edit - the edit.
 * @param index - the edit's index in `ruling.proposedEdits`.
 * @returns `pending` only when applying it would not be refused for a changed section.
 */
export function proposedEditState(
  snapshot: ArchitectureSnapshot,
  record: RulingRecord,
  edit: ProposedEdit,
  index: number,
): ProposedEditState {
  if (record.appliedEdits.includes(index)) return 'applied'
  if (record.dismissedEdits.includes(index)) return 'dismissed'
  // The architect read the section at `edit.hash`; any other current hash means applying would be refused.
  const current = snapshot.index.sections.find(entry => entry.path === edit.path && entry.anchor === edit.anchor)
  return current?.hash === edit.hash ? 'pending' : 'changed'
}

/**
 * Count the proposed edits of a Ruling that the user can still apply.
 * @param snapshot - the repository's current state.
 * @param record - the Ruling.
 * @returns the number of pending edits.
 */
export function pendingEdits(snapshot: ArchitectureSnapshot, record: RulingRecord): number {
  return record.ruling.proposedEdits.filter((edit, index) => proposedEditState(snapshot, record, edit, index) === 'pending').length
}

/** Actions the proposed-edit list needs from the page. */
export interface ProposedEditActions {
  /** Read one section's current text. */
  readonly readSection: (workspaceId: WorkspaceId, path: string, anchor: string) => Promise<ArchitectureSectionValue | undefined>
  /** Apply one proposed edit; resolves to the failure message, or undefined once written. */
  readonly applyProposedEdit: (workspaceId: WorkspaceId, rulingId: RulingId, index: number, accept: boolean) => Promise<string | undefined>
  /** Dismiss one proposed edit; resolves to the failure message, or undefined once recorded. */
  readonly dismissProposedEdit: (workspaceId: WorkspaceId, rulingId: RulingId, index: number) => Promise<string | undefined>
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
    <Fold variant="section" heading={t('ruling.proposedEdits')} defaultOpen aside={<span className={css.meta}>{String(record.ruling.proposedEdits.length)}</span>}>
      <p className={css.meta}>{t('ruling.proposedEdits.hint')}</p>
      <ul className={css.proposals}>
        {record.ruling.proposedEdits.map((edit, index) => (
          <ProposedEditItem key={`${edit.path}#${edit.anchor}`} {...props} edit={edit} index={index} state={proposedEditState(props.snapshot, record, edit, index)} />
        ))}
      </ul>
    </Fold>
  )
}

const STATE_TONE: Readonly<Record<Exclude<ProposedEditState, 'pending'>, TagTone>> = {
  applied: 'success',
  dismissed: 'quiet',
  changed: 'warning',
}

type CurrentText = { readonly kind: 'loading' } | { readonly kind: 'text'; readonly text: string } | { readonly kind: 'gone' }

/** Props of {@link ProposedEditItem}. */
export type ProposedEditItemProps = ProposedEditsProps & {
  readonly edit: ProposedEdit
  readonly index: number
  readonly state: ProposedEditState
  /** Heading of the item; the target section by default, the Ruling in a list grouped by section. */
  readonly heading?: ReactNode
}

/**
 * Render one proposed edit with its state and, while pending, its diff, apply, and dismiss actions.
 * @param props - the edit, its Ruling and state, the actions, and copy.
 * @returns the list item.
 */
export function ProposedEditItem(props: ProposedEditItemProps): ReactNode {
  const { workspaceId, record, edit, index, state, applyProposedEdit, dismissProposedEdit, heading, t } = props
  const cite = `${edit.path}#${edit.anchor}`
  const pending = state === 'pending'
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const labels = useMemo<DiffBlockLabels>(() => ({
    copy: t('markdown.copy'),
    copied: t('markdown.copied'),
    codeLabel: t('markdown.codeBlock'),
    wrapLabel: t('markdown.wrap'),
    unwrapLabel: t('markdown.unwrap'),
    collapseAria: t('diff.collapse'),
    expandAria: hidden => counted(t, 'diff.expandAria', hidden),
    collapse: t('diff.collapse'),
    expand: hidden => counted(t, 'diff.expand', hidden),
  }), [t])
  const run = (action: () => Promise<string | undefined>): void => {
    setBusy(true)
    setFailure(undefined)
    void action().then((message) => {
      setBusy(false)
      setFailure(message)
    })
  }
  const apply = (accept: boolean): void => { run(() => applyProposedEdit(workspaceId, record.ruling.id, index, accept)) }
  return (
    <li className={css.proposal}>
      <header className={css.cardHeading}>
        <span className={css.cites}>{heading ?? cite}</span>
        {state !== 'pending' && <Tag tone={STATE_TONE[state]}>{t(`ruling.proposedEdit.${state}`)}</Tag>}
      </header>
      <p>{edit.rationale}</p>
      {state === 'changed' && <p className={css.meta}>{t('ruling.proposedEdit.changedHint')}</p>}
      {pending && (
        <>
          {/* The apply actions sit under the diff, so the user applies only text they have seen. */}
          <Fold variant="section" heading={t('ruling.proposedEdit.changes')} defaultOpen={false}>
            <CurrentDiff {...props} cite={cite} labels={labels}>
              <footer className={css.readerFooter}>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => { apply(true) }}>{t('ruling.proposedEdit.applyAccept')}</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => { apply(false) }}>{t('ruling.proposedEdit.apply')}</Button>
              </footer>
            </CurrentDiff>
          </Fold>
          <footer className={css.proposalActions}>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { run(() => dismissProposedEdit(workspaceId, record.ruling.id, index)) }}>
              {t('ruling.proposedEdit.dismiss')}
            </Button>
          </footer>
        </>
      )}
      {failure !== undefined && <p className={css.notice} role="alert">{t('ruling.proposedEdit.failed', { message: failure })}</p>}
    </li>
  )
}

/** The current section against the proposed text; the section is read once the diff is shown. */
type CurrentDiffProps = ProposedEditItemProps & { readonly cite: string; readonly labels: DiffBlockLabels; readonly children: ReactNode }

function CurrentDiff(props: CurrentDiffProps): ReactNode {
  const { workspaceId, edit, cite, labels, readSection, children, t } = props
  const [current, setCurrent] = useState<CurrentText>({ kind: 'loading' })
  useEffect(() => {
    let live = true
    void readSection(workspaceId, edit.path, edit.anchor).then((value) => {
      if (live) setCurrent(value === undefined ? { kind: 'gone' } : { kind: 'text', text: value.text })
    })
    return () => { live = false }
  }, [workspaceId, edit.path, edit.anchor, readSection])
  if (current.kind === 'loading') return <p className={css.meta} role="status">{t('section.loading')}</p>
  if (current.kind === 'gone') return <p className={css.notice} role="alert">{t('section.failed')}</p>
  return (
    <>
      <DiffBlock diffs={[{ path: cite, oldText: current.text, newText: edit.content }]} labels={labels} />
      {children}
    </>
  )
}
