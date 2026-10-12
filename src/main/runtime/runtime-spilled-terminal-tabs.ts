// #18202: terminal tabs of local worktrees that an older build saved in `runtime:<env>` partitions.
// The local partition's load folds them in (`workspace-layout-load-spill.ts`); the first load then
// moves them out of the spill partitions, so a tab later closed in local is not folded back.

import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import type { SpilledTerminalTabs } from '../../shared/workspace-layout/workspace-layout-load-spill'
import type { LoadedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load-types'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import { closeTerminalTabInWorkspaceSession } from '../../shared/workspace-session-terminal-tab-close'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { RuntimeStore } from './runtime-store-contract'
import type { HolderStore, RuntimeWorkspaceLayoutWriter } from './runtime-workspace-layout-writer'

type SpillStore = Pick<HolderStore, 'getWorkspaceSession' | 'getWorkspaceSessionHostIds'>
/** Only a repo or folder the Store records as local: a server workspace's key also routes local. */
type KnownLocal = (key: string) => boolean
type HolderWriter = Pick<
  RuntimeWorkspaceLayoutWriter,
  'noteRead' | 'savedSession' | 'write' | 'dropSpillCopies'
>

/** Sorted, so the first partition's copy is the one folded. */
function runtimePartitionHostIds(store: SpillStore): ExecutionHostId[] {
  return store
    .getWorkspaceSessionHostIds()
    .filter((hostId) => parseExecutionHostId(hostId)?.kind === 'runtime')
    .sort()
}

/** The Loader's spill input: only the local partition takes in spilled tabs. */
export function spilledTerminalTabsFor(
  store: SpillStore,
  hostId: ExecutionHostId,
  knownLocal: KnownLocal
): SpilledTerminalTabs | undefined {
  if (hostId !== LOCAL_EXECUTION_HOST_ID) {
    return undefined
  }
  return {
    sessions: runtimePartitionHostIds(store).map((id) => store.getWorkspaceSession(id)),
    ownsKey: knownLocal
  }
}

/** A partition the holder holds, as the Store has it, with any spilled tabs folded in. */
export function loadHeldPartition(
  store: SpillStore,
  writer: HolderWriter,
  hostId: ExecutionHostId,
  knownLocal: KnownLocal
): LoadedWorkspaceLayout {
  const session = store.getWorkspaceSession(hostId)
  const { changes: _changes, ...loaded } = loadWorkspaceLayout(
    hostId,
    session,
    nameBasedLoadContext(),
    spilledTerminalTabsFor(store, hostId, knownLocal)
  )
  writer.noteRead(hostId, session)
  return loaded
}

/** Each runtime partition that held a spill copy, without its copies of `ownsKey`'s terminal tabs. */
function withoutSpilledTerminalTabs(
  store: SpillStore,
  ownsKey: (key: string) => boolean
): Map<ExecutionHostId, WorkspaceSessionState> {
  const stripped = new Map<ExecutionHostId, WorkspaceSessionState>()
  for (const hostId of runtimePartitionHostIds(store)) {
    const stored = store.getWorkspaceSession(hostId)
    let next = stored
    for (const [key, rows] of Object.entries(stored.tabsByWorktree ?? {})) {
      if (ownsKey(key)) {
        for (const row of rows) {
          next = closeTerminalTabInWorkspaceSession(next, key, row.id, { force: true }).session
        }
      }
    }
    if (next !== stored) {
      stripped.set(hostId, next)
    }
  }
  return stripped
}

/**
 * Once the holder holds the loaded local partition: writes the fold to local first, then drops the
 * spill copies (each one folded, or lost to local's own), so a crash between keeps both.
 */
export function retireSpilledTerminalTabs(
  store: HolderStore,
  writer: HolderWriter,
  loaded: LoadedWorkspaceLayout,
  knownLocal: KnownLocal
): void {
  const hostId = loaded.layout.hostId
  if (hostId !== LOCAL_EXECUTION_HOST_ID) {
    return
  }
  const stripped = withoutSpilledTerminalTabs(store, knownLocal)
  if (stripped.size === 0) {
    return
  }
  const before = writer.savedSession(hostId)
  writer.write(hostId, loaded, true)
  if (writer.savedSession(hostId) === before) {
    return
  }
  for (const [spillHostId, next] of stripped) {
    writer.dropSpillCopies(spillHostId, next)
  }
}

/** A key whose repo or folder record the Store holds, routed to the local partition. */
export function isStoreRecordedLocalWorkspace(
  store: Pick<RuntimeStore, 'getRepo' | 'getFolderWorkspaces'> | null | undefined,
  key: string,
  homeHostId: (key: string) => ExecutionHostId | null
): boolean {
  const scope = parseWorkspaceKey(key)
  const recorded =
    scope?.type === 'folder'
      ? Boolean(
          store?.getFolderWorkspaces?.().some((folder) => folder.id === scope.folderWorkspaceId)
        )
      : Boolean(
          store?.getRepo?.(
            getRepoIdFromWorktreeId(scope?.type === 'worktree' ? scope.worktreeId : key)
          )
        )
  return recorded && homeHostId(key) === LOCAL_EXECUTION_HOST_ID
}
