/** A collapsible block of the dashboard: a toggle heading, inline tags beside it, and content shown while open. */
import { useState, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular, IconChevronUpOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ArchitecturePage.module.css'

/** Props of {@link Fold}. */
export interface FoldProps {
  /** Toggle text; while collapsed a card heading shows one line of it. */
  readonly heading: ReactNode
  /** `card` heads a Ruling or appeal card; `section` heads a part of one. */
  readonly variant: 'card' | 'section'
  /** Initial state; the user's toggles are kept while the block stays mounted. */
  readonly defaultOpen: boolean
  /** Tags and counts beside the heading, shown in both states. */
  readonly aside?: ReactNode
  readonly children: ReactNode
}

/**
 * Render a collapsible block whose heading is a disclosure button.
 * @param props - heading, variant, initial state, inline tags, and content.
 * @returns the block.
 */
export function Fold({ heading, variant, defaultOpen, aside, children }: FoldProps): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  const Chevron = open ? IconChevronUpOutlineRegular : IconChevronDownOutlineRegular
  const toggle = (
    <button type="button" className={css.foldToggle} aria-expanded={open} onClick={() => { setOpen(!open) }}>
      <Chevron className={css.foldChevron} />
      <span className={variant === 'card' ? css.question : css.foldTitle}>{heading}</span>
    </button>
  )
  return (
    <div className={css.fold} data-open={open || undefined}>
      <div className={variant === 'card' ? css.cardHeading : css.foldHeading}>
        {variant === 'card' ? toggle : <h3 className={css.subheading}>{toggle}</h3>}
        {aside}
      </div>
      {open && children}
    </div>
  )
}
