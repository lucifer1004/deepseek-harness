/**
 * The proposed edits the user can still apply, grouped by the section they rewrite, so alternatives for one section
 * sit together. Applying one changes the section, which blocks the others through the hash rule.
 */
import type { ReactNode } from 'react'
import type { ArchitectureSnapshot, RulingRecord } from '@deepseek-ai/dsh-experimental-api-architecture/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { counted } from './counted.ts'
import { ProposedEditItem, proposedEditState, type ProposedEditActions } from './ProposedEdits.tsx'
import type { Translate } from './SettingsView.tsx'
import css from './ArchitecturePage.module.css'

/** One pending proposed edit and the Ruling that carries it. */
interface PendingEdit {
  readonly record: RulingRecord
  readonly index: number
}

/**
 * Group the pending proposed edits of every Ruling by target section, newest Ruling first within a group.
 * @param snapshot - the followed repository state.
 * @returns `[path#anchor, edits]` pairs in index order of the target sections.
 */
export function pendingBySection(snapshot: ArchitectureSnapshot): Array<[string, PendingEdit[]]> {
  const groups = new Map<string, PendingEdit[]>()
  // The snapshot lists Rulings newest first.
  for (const record of snapshot.rulings) {
    for (const [index, edit] of record.ruling.proposedEdits.entries()) {
      if (proposedEditState(snapshot, record, edit, index) !== 'pending') continue
      const cite = `${edit.path}#${edit.anchor}`
      groups.set(cite, [...groups.get(cite) ?? [], { record, index }])
    }
  }
  // A pending edit names an indexed section, so index order covers every group.
  const order = snapshot.index.sections.map(section => `${section.path}#${section.anchor}`)
  return [...groups].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
}

/**
 * The first group of a Ruling id, as a worker names the Ruling in prose: `ruling-b9c92c10-…` reads `b9c92c10`.
 * @param id - the Ruling id.
 * @returns the short form.
 */
export function shortRulingId(id: string): string {
  const rest = id.replace(/^ruling-/, '')
  const dash = rest.indexOf('-')
  return dash === -1 ? rest : rest.slice(0, dash)
}

/** Props of {@link ToReview}. */
export interface ToReviewProps extends ProposedEditActions {
  readonly workspaceId: WorkspaceId
  readonly snapshot: ArchitectureSnapshot
  readonly t: Translate
}

/**
 * Render the pending proposed edits, or nothing when none is pending.
 * @param props - the followed snapshot, the actions, and copy.
 * @returns the block.
 */
export function ToReview(props: ToReviewProps): ReactNode {
  const { snapshot, t } = props
  const groups = pendingBySection(snapshot)
  if (groups.length === 0) return null
  return (
    <section className={css.review} aria-labelledby="architecture-to-review">
      <h2 id="architecture-to-review" className={css.reviewHeading}>
        {t('review.title')}
        <span className={css.meta}>{counted(t, 'ruling.pendingEdits', groups.reduce((sum, [, edits]) => sum + edits.length, 0))}</span>
      </h2>
      <p className={css.meta}>{t('ruling.proposedEdits.hint')}</p>
      <ul className={css.cards}>
        {groups.map(([cite, edits]) => (
          <li key={cite} className={css.card}>
            <header className={css.cardHeading}>
              <span className={css.question}>{cite}</span>
              {edits.length > 1 && <span className={css.meta}>{counted(t, 'review.alternatives', edits.length)}</span>}
            </header>
            {edits.length > 1 && <p className={css.meta}>{t('review.alternativesHint')}</p>}
            <ul className={css.proposals}>
              {edits.map(({ record, index }) => {
                const edit = record.ruling.proposedEdits[index]
                /* v8 ignore next -- pendingBySection lists only existing edits. */
                if (edit === undefined) return null
                return (
                  <ProposedEditItem
                    key={`${record.ruling.id}#${String(index)}`}
                    {...props}
                    record={record}
                    edit={edit}
                    index={index}
                    state="pending"
                    heading={(
                      // A Ruling question can run to paragraphs; two lines identify it, the tooltip holds the rest.
                      <span className={css.editRuling} title={record.ruling.question}>
                        <span className={css.rulingId}>{shortRulingId(record.ruling.id)}</span>
                        {' '}
                        {record.ruling.question}
                      </span>
                    )}
                  />
                )
              })}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  )
}
