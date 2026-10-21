import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'
import { PANE_NOT_LIVE_ERROR } from '../../../../shared/pane-attach-only-view'
import { retireHiddenRendererPtyDropMemory } from '../../pty-hidden-delivery-gate'
import type {
  IPtyProvider,
  PtySpawnOptions,
  PtySpawnResult
} from '../../../providers/pty-provider-contract'

/**
 * Layout-owner build: a window view of a pane with no recorded owner attaches to the terminal it
 * names, or starts nothing; main starts a pane whose terminal is gone.
 */
export async function attachViewWithoutOwner(
  provider: IPtyProvider,
  spawnOptions: PtySpawnOptions
): Promise<PtySpawnResult> {
  if (!spawnOptions.sessionId) {
    throw new Error(PANE_NOT_LIVE_ERROR)
  }
  try {
    return await provider.spawn({
      cols: spawnOptions.cols,
      rows: spawnOptions.rows,
      sessionId: spawnOptions.sessionId,
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

/**
 * Layout-owner build: main started the pane hidden, dropping its output; the view's attach
 * snapshot, taken after this unmark, holds those bytes, so the view paints once, not twice.
 */
export async function attachViewAfterHiddenStart<T extends object>(
  ptyId: string,
  unmarkHidden: (id: string) => void,
  attach: () => Promise<T>
): Promise<T> {
  unmarkHidden(ptyId)
  const attached = await attach()
  // Why a snapshot of the same id: a local attach carries none, and another id's drops may postdate it.
  if (
    'id' in attached &&
    attached.id === ptyId &&
    'snapshot' in attached &&
    typeof attached.snapshot === 'string'
  ) {
    retireHiddenRendererPtyDropMemory(ptyId)
  }
  return attached
}
