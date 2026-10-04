/** Count-dependent dashboard copy: each countable key has `.one` and `.other` forms in every locale. */
import type { Translate } from './SettingsView.tsx'

/** Keys whose copy depends on a count. */
export type CountedKey =
  | 'count.sources'
  | 'count.sections'
  | 'problems'
  | 'diagnostics'
  | 'diff.expandAria'
  | 'diff.expand'
  | 'ruling.count.constraints'
  | 'ruling.count.proposedEdits'
  | 'ruling.pendingEdits'

/**
 * Translate a count with the form its number takes.
 * @param t - the dashboard's translate function.
 * @param key - the countable key.
 * @param count - the number counted.
 * @returns the copy with `{count}` filled in.
 */
export function counted(t: Translate, key: CountedKey, count: number): string {
  return t(`${key}.${count === 1 ? 'one' : 'other'}`, { count: String(count) })
}
