/** Decorative occupant for the architecture sidebar entry. */
import { IconWorkspaceTreeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the tree glyph at the size the sidebar asks for; the sidebar owns the accessible label.
 * @param props - the sidebar's icon share.
 * @returns decorative icon.
 */
export function ArchitectureIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconWorkspaceTreeOutlineRegular size={size} />
}
