import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'
import { PANE_NOT_LIVE_ERROR } from '../../../../shared/pane-attach-only-view'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import type { StablePaneSpawnContext } from './stable-owner'

/**
 * Layout-owner build: a window view of a pane with no recorded owner attaches to the terminal it
 * names, or starts nothing; main starts a pane whose terminal is gone.
 */
export async function attachViewWithoutOwner(
  args: StablePaneSpawnContext
): Promise<PtySpawnResult> {
  if (!args.spawnOptions.sessionId) {
    throw new Error(PANE_NOT_LIVE_ERROR)
  }
  try {
    return await args.provider.spawn({
      cols: args.spawnOptions.cols,
      rows: args.spawnOptions.rows,
      sessionId: args.spawnOptions.sessionId,
      attachOnly: true
    })
  } catch (error) {
    throw error instanceof SessionNotFoundError ? new Error(PANE_NOT_LIVE_ERROR) : error
  }
}

/** The spawn's attach-only flag; a build without the switch keeps today's start. */
export function attachOnlyViewOf(args: { attachOnlyView?: unknown }): true | undefined {
  return ORCA_LAYOUT_OWNER_IS_MAIN && args.attachOnlyView === true ? true : undefined
}
