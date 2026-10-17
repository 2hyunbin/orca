import { useAppStore, type AppState } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import {
  PairedServerRowsSnapshotSchema,
  type PairedServerWorkspaceRow
} from '../../../../shared/sidebar-list/paired-server-rows'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import { defineSidebarShadowDomain, type SidebarShadowMainRead } from './sidebar-shadow-comparison'

/** The paired-server rows the window fetched itself, keyed by host-qualified id, for these hosts. */
export function readWindowPairedServerRows(
  state: Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces'>,
  hostIds: ReadonlySet<string>
): Map<string, PairedServerWorkspaceRow> {
  const rows = new Map<string, PairedServerWorkspaceRow>()
  const add = (worktree: Worktree, kind: PairedServerWorkspaceRow['kind']): void => {
    if (!worktree.hostId || !hostIds.has(worktree.hostId)) {
      return
    }
    const key = getWorktreeHostIdentity(worktree)
    rows.set(key, {
      key,
      worktreeId: worktree.id,
      repoId: worktree.repoId,
      kind,
      path: worktree.path,
      branch: worktree.branch,
      displayName: worktree.displayName,
      isArchived: worktree.isArchived,
      isPinned: worktree.isPinned
    })
  }
  for (const worktree of getAllWorktreesFromState(state)) {
    add(worktree, 'git')
  }
  for (const folder of state.folderWorkspaces ?? []) {
    add(folderWorkspaceToWorktree(folder), 'folder')
  }
  return rows
}

export const pairedServerRowsShadow = defineSidebarShadowDomain<
  PairedServerWorkspaceRow,
  SidebarShadowMainRead<PairedServerWorkspaceRow> & { liveHostIds: ReadonlySet<string> }
>({
  name: 'paired-server-rows',
  readMain: async () => {
    const response = await window.api.runtime.call({ method: 'sidebarInputs.pairedServerRows' })
    const parsed = response.ok ? PairedServerRowsSnapshotSchema.safeParse(response.result) : null
    if (!parsed?.success) {
      return null
    }
    // Only servers main last reached: an unverifiable server's rows are its last, not its current.
    const live = parsed.data.servers.filter((server) => server.freshness === 'live')
    return {
      revision: parsed.data.revision,
      values: new Map(live.flatMap((server) => server.rows.map((row) => [row.key, row]))),
      liveHostIds: new Set(live.map((server) => server.hostId))
    }
  },
  readWindow: (main) => readWindowPairedServerRows(useAppStore.getState(), main.liveHostIds),
  equals: (window, main) => JSON.stringify(window ?? null) === JSON.stringify(main ?? null)
})
