import { useAppStore, type AppState } from '@/store'
import { getAllWorktreesFromState, getRepoMapFromState } from '@/store/selectors'
import { getLiveAgentStatusByWorktreeId } from '@/lib/worktree-activity-state'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { getWorktreeIdsWithStructuredChat } from '@/components/sidebar/visible-worktree-activity-inputs'
import {
  getSettingsFocusedExecutionHostId,
  getWorktreeExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host'
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

// A paired server publishes its own rows' facts; that comparison belongs to the server-row producer.
function withoutPairedServerRows<Value>(
  state: AppState,
  values: ReadonlyMap<string, Value>
): Map<string, Value> {
  const worktreeById = new Map(getAllWorktreesFromState(state).map((row) => [row.id, row]))
  const repoById = getRepoMapFromState(state)
  const defaultHostId = getSettingsFocusedExecutionHostId(state.settings)
  const scoped = new Map<string, Value>()
  for (const [id, value] of values) {
    const worktree = worktreeById.get(id)
    const hostId = worktree
      ? getWorktreeExecutionHostId(worktree, repoById.get(worktree.repoId), defaultHostId)
      : defaultHostId
    if (parseExecutionHostId(hostId)?.kind !== 'runtime') {
      scoped.set(id, value)
    }
  }
  return scoped
}

export const workspaceActivityShadow = defineSidebarShadowDomain<WorkspaceActivityFacts>({
  name: 'workspace-activity',
  readWindow: () => {
    const state = useAppStore.getState()
    return withoutPairedServerRows(state, readWindowWorkspaceActivityFacts(state, Date.now()))
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
      values: withoutPairedServerRows(
        useAppStore.getState(),
        new Map(Object.entries(parsed.data.facts))
      )
    }
  },
  // The window has no unverifiable state: a terminal whose host lost contact still reads live there.
  equals: (window, main) =>
    workspaceActivityFactsEqual(window ?? IDLE_WORKSPACE_ACTIVITY, {
      ...(main ?? IDLE_WORKSPACE_ACTIVITY),
      terminal: main?.terminal ? 'live' : null
    })
})
