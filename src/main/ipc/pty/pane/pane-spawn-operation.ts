import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import type { Store } from '../../../persistence'
import type { PersistPtyBindingArgs } from '../../../persistence/loading-store/pty-binding-persistence'
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

/** Runs inside the existing durable mutation, after source/topology checks and before any bind. */
export function fenceFreshPaneBinding(
  store: Store,
  binding: PersistPtyBindingArgs,
  stoppedPtyId?: string,
  connectionId?: string | null
): () => PersistPtyBindingArgs {
  return () => {
    const hostId = connectionId ? toSshExecutionHostId(connectionId) : undefined
    const session = store.getWorkspaceSession(hostId)
    const paneKey = makePaneKey(binding.tabId, binding.leafId)
    if (ptyBindingIsRefused(binding, session, binding.worktreeId, paneKey, [])) {
      return binding
    }
    const bound = session.terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId?.[binding.leafId]
    const stamp = session.terminalPtyIncarnationsByPaneKey?.[paneKey]
    if (
      bound &&
      bound !== stoppedPtyId &&
      (bound !== binding.ptyId || stamp !== binding.incarnationId)
    ) {
      throw new PaneOwnerContentionError()
    }
    return binding
  }
}
