/** Browser entry for the architecture Remote contribution and dashboard page. */
import type { Context } from '@deepseek-ai/cordis'
import architectureRemote from '@deepseek-ai/dsh-experimental-api-architecture/remote'
import { mountArchitecture } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Activate the architecture dashboard.
 * @param ctx - Client runtime.
 * @returns complete UI and Remote disposer.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return await mountArchitecture(ctx, architectureRemote)
}
