import { useAppStore, type AppState } from '@/store'
import { getAllWorktreesFromState, getRepoMapFromState } from '@/store/selectors'
import { getLiveAgentStatusByWorktreeId } from '@/lib/worktree-activity-state'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { getWorktreeIdsWithStructuredChat } from '@/components/sidebar/visible-worktree-activity-inputs'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  IDLE_WORKSPACE_ACTIVITY,
  isIdleWorkspaceActivity,
  workspaceActivityFactsEqual,
  WorkspaceActivityFactsSnapshotSchema,
  type WorkspaceActivityFacts
} from '../../../../shared/sidebar-list/workspace-activity-facts'
import { defineSidebarShadowDomain } from './sidebar-shadow-comparison'

/** The window's own activity facts, from the same store slices the sidebar filter reads. */
export function readWindowWorkspaceActivityFacts(
  state: Pick<
    AppState,
    | 'tabsByWorktree'
    | 'ptyIdsByTabId'
    | 'browserTabsByWorktree'
    | 'unifiedTabsByWorktree'
    | 'agentStatusByPaneKey'
  >,
  now: number
): Map<string, WorkspaceActivityFacts> {
  const structuredChatIds = getWorktreeIdsWithStructuredChat(state.unifiedTabsByWorktree)
  const agentById = getLiveAgentStatusByWorktreeId(
    state.agentStatusByPaneKey,
    state.tabsByWorktree,
    now
  )
  const ids = new Set([
    ...Object.keys(state.tabsByWorktree),
    ...Object.keys(state.browserTabsByWorktree),
    ...structuredChatIds,
    ...agentById.keys()
  ])
  const facts = new Map<string, WorkspaceActivityFacts>()
  for (const id of ids) {
    const fact: WorkspaceActivityFacts = {
      terminal: (state.tabsByWorktree[id] ?? []).some((tab) =>
        tabHasLivePty(state.ptyIdsByTabId, tab.id)
      )
        ? 'live'
        : null,
      browser: (state.browserTabsByWorktree[id]?.length ?? 0) > 0,
      structuredChat: structuredChatIds.has(id),
      agent: agentById.get(id) ?? null
    }
    if (!isIdleWorkspaceActivity(fact)) {
      facts.set(id, fact)
    }
  }
  return facts
}

// The local runtime answers for the rows it owns. A paired server owns and publishes its own rows'
// facts, which the server-row producer compares; an id with no owner in the catalog is no row.
function toLocallyOwnedRows<Value>(
  state: AppState,
  values: ReadonlyMap<string, Value>
): Map<string, Value> {
  const worktreeById = new Map(getAllWorktreesFromState(state).map((row) => [row.id, row]))
  const folderById = new Map((state.folderWorkspaces ?? []).map((folder) => [folder.id, folder]))
  const repoById = getRepoMapFromState(state)
  const ownerOf = (id: string): ExecutionHostId | null => {
    const worktree = worktreeById.get(id)
    const scope = parseWorkspaceKey(id)
    const hostFields = worktree
      ? repoById.get(worktree.repoId)
      : scope?.type === 'folder'
        ? folderById.get(scope.folderWorkspaceId)
        : undefined
    return worktree?.hostId ?? (hostFields ? getRepoExecutionHostId(hostFields) : null)
  }
  const scoped = new Map<string, Value>()
  for (const [id, value] of values) {
    const owner = ownerOf(id)
    if (owner !== null && parseExecutionHostId(owner)?.kind !== 'runtime') {
      scoped.set(id, value)
    }
  }
  return scoped
}

export const workspaceActivityShadow = defineSidebarShadowDomain<WorkspaceActivityFacts>({
  name: 'workspace-activity',
  readWindow: () => {
    const state = useAppStore.getState()
    return toLocallyOwnedRows(state, readWindowWorkspaceActivityFacts(state, Date.now()))
  },
  readMain: async () => {
    const response = await window.api.runtime.call({ method: 'sidebarInputs.activityFacts' })
    const parsed = response.ok
      ? WorkspaceActivityFactsSnapshotSchema.safeParse(response.result)
      : null
    if (!parsed?.success) {
      return null
    }
    return {
      revision: parsed.data.revision,
      values: toLocallyOwnedRows(useAppStore.getState(), new Map(Object.entries(parsed.data.facts)))
    }
  },
  // The window has no unverifiable state: a terminal whose host lost contact still reads live there.
  equals: (window, main) =>
    workspaceActivityFactsEqual(window ?? IDLE_WORKSPACE_ACTIVITY, {
      ...(main ?? IDLE_WORKSPACE_ACTIVITY),
      terminal: main?.terminal ? 'live' : null
    })
})
