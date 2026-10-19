import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import type { Store } from '../../../persistence'
import { ptyBindingIsRefused } from '../../../persistence/loading-store/pty-binding-refusals'

export class PaneOwnerContentionError extends Error {
  constructor() {
    super('terminal_pane_owner_changed')
  }
}

/** In-process authority of the enclosing operation; never sent over IPC/RPC or saved. */
export type PaneSpawnOperation = { mustExist: boolean }

export function assertPaneStillExists(
  store: Store | undefined,
  worktreeId: string,
  tabId: string,
  leafId: string,
  connectionId?: string | null
): void {
  if (!store) {
    throw new Error('terminal_pane_owner_changed')
  }
  const session = store.getWorkspaceSession(
    connectionId ? toSshExecutionHostId(connectionId) : undefined
  )
  if (
    ptyBindingIsRefused(
      { tabId, leafId, mayCreate: false },
      session,
      worktreeId,
      makePaneKey(tabId, leafId),
      []
    )
  ) {
    throw new Error('terminal_pane_owner_changed')
  }
}
