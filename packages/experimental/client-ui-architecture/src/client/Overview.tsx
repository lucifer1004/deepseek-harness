/** Dashboard overview: the counts that say what needs attention, each opening the view that lists them. */
import type { ReactNode } from 'react'
import type { ArchitectureSnapshot } from '@deepseek-ai/dsh-experimental-api-architecture/types'
import type { ArchitectureKey } from './locales.ts'
import { counted } from './counted.ts'
import { pendingEdits } from './ProposedEdits.tsx'
import css from './Overview.module.css'

/** Views an overview card can open. */
export type OverviewTarget = 'architecture' | 'consultations' | 'appeals'

/** One overview figure; `attention` marks a count the user should act on. */
export interface OverviewFigure {
  readonly key: 'record' | 'uncommitted' | 'review' | 'stale' | 'appeals'
  readonly value: number
  readonly target: OverviewTarget
  readonly attention: boolean
}

/**
 * Derive the overview figures of a snapshot.
 * @param snapshot - the dashboard snapshot.
 * @returns the figures in display order.
 */
export function overviewFigures(snapshot: ArchitectureSnapshot): readonly OverviewFigure[] {
  const uncommitted = Object.values(snapshot.sourceStatus).filter(status => status !== 'committed').length
  const review = snapshot.rulings.reduce((sum, record) => sum + pendingEdits(snapshot, record), 0)
  const stale = snapshot.rulings.filter(record => record.stale).length
  const appeals = snapshot.appeals.filter(appeal => appeal.adjudication === undefined).length
  return [
    { key: 'record', value: snapshot.index.sections.length, target: 'architecture', attention: false },
    { key: 'uncommitted', value: uncommitted, target: 'architecture', attention: uncommitted > 0 },
    { key: 'review', value: review, target: 'consultations', attention: review > 0 },
    { key: 'stale', value: stale, target: 'consultations', attention: false },
    { key: 'appeals', value: appeals, target: 'appeals', attention: appeals > 0 },
  ]
}

/**
 * Render the overview strip.
 * @param props - the snapshot, the view opener, and the dashboard copy.
 * @returns one button per figure.
 */
export function Overview({ snapshot, open, t }: {
  snapshot: ArchitectureSnapshot
  open: (target: OverviewTarget, figure: OverviewFigure['key']) => void
  t: (key: ArchitectureKey, params?: Record<string, string>) => string
}): ReactNode {
  return (
    <ul className={css.overview} aria-label={t('overview.label')}>
      {overviewFigures(snapshot).map(figure => (
        <li key={figure.key}>
          <button
            type="button"
            className={css.figure}
            data-attention={figure.attention ? '' : undefined}
            data-empty={figure.value === 0 ? '' : undefined}
            onClick={() => { open(figure.target, figure.key) }}
          >
            <span className={css.value}>{String(figure.value)}</span>
            <span className={css.label}>
              {figure.key === 'record'
                ? t('overview.record', { sources: counted(t, 'count.sources', snapshot.index.sources.length) })
                : counted(t, `overview.${figure.key}`, figure.value)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
