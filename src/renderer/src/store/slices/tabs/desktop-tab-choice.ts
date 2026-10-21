import type { StoreApi } from 'zustand'
import { structuredAgentSessionTabId } from '../../../../../shared/structured-agent-session-projection'
import { toHostSessionTabId } from '../../../../../shared/terminal-surface-id'
import type { AppState } from '../../types'
import { toVisibleTabType, type Tab } from '../../../../../shared/tab-types'
import type { RuntimeMobileSessionClientTab } from '../../../../../shared/runtime-types'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import {
  resolveWorkspaceViewerTab,
  SESSION_TAB_IDENTITY
} from '../../../../../shared/workspace-creation-tab'
import type { DesktopLayoutView } from '../../../../../shared/workspace-layout/workspace-layout-beside'
import { emptyLayoutViewRecord } from '../../../../../shared/workspace-layout/workspace-layout-views'

export type DesktopChoiceState = Partial<
  Pick<AppState, 'desktopLayoutView' | 'folderWorkspaces' | 'tabsByWorktree'>
> & {
  worktreesByRepo?: Record<string, readonly { id: string; createdWithAgent?: string }[]>
}

export function desktopChosenTabId(state: DesktopChoiceState, worktreeId: string): string | null {
  const view = state.desktopLayoutView
  const groups = view?.groups[worktreeId] ?? {}
  const activeGroup = view?.activeGroupIdByWorktree?.[worktreeId]
  return (
    (activeGroup ? groups[activeGroup]?.activeTabId : null) ??
    Object.values(groups).find((group) => group.activeTabId)?.activeTabId ??
    null
  )
}

/** Explicit navigation updates the raw view; inventory and display never write it. */
export function withDesktopTabChoice(
  view: DesktopLayoutView | undefined,
  worktreeId: string,
  tab: Tab
): DesktopLayoutView {
  const raw = view ?? emptyLayoutViewRecord()
  const type = toVisibleTabType(tab.contentType)
  const field =
    type === 'editor'
      ? 'activeFileIdByWorktree'
      : type === 'browser'
        ? 'activeBrowserTabIdByWorktree'
        : 'activeTabIdByWorktree'
  return {
    ...raw,
    groups: {
      ...raw.groups,
      [worktreeId]: { ...raw.groups[worktreeId], [tab.groupId]: { activeTabId: tab.id } }
    },
    activeGroupIdByWorktree: { ...raw.activeGroupIdByWorktree, [worktreeId]: tab.groupId },
    activeTabTypeByWorktree: { ...raw.activeTabTypeByWorktree, [worktreeId]: type },
    [field]: {
      ...raw[field],
      [worktreeId]: type === 'agent-session' || type === 'simulator' ? tab.id : tab.entityId
    }
  }
}

/** Navigation adapters record the actual surface after it opens. */
export function chooseWorkspaceTabInStore(
  worktreeId: string,
  tabId: string,
  store: Pick<StoreApi<AppState>, 'getState' | 'setState'>
): boolean {
  const state = store.getState()
  const tabs = state.unifiedTabsByWorktree?.[worktreeId] ?? []
  const tab =
    tabs.find((candidate) => candidate.id === tabId) ??
    tabs.find((candidate) => candidate.entityId === tabId)
  if (!tab) {
    return false
  }
  store.setState({
    desktopLayoutView: withDesktopTabChoice(state.desktopLayoutView, worktreeId, tab)
  })
  state.activateTab(tab.id, { worktreeId })
  return true
}

/** The agent a workspace was created with, while this window has chosen none of its tabs. */
export function unchosenCreationAgent(
  state: DesktopChoiceState,
  worktreeId: string
): string | undefined {
  if (desktopChosenTabId(state, worktreeId)) {
    return undefined
  }
  const scope = parseWorkspaceKey(worktreeId)
  return scope?.type === 'folder'
    ? state.folderWorkspaces?.find((folder) => folder.id === scope.folderWorkspaceId)
        ?.createdWithAgent
    : Object.values(state.worktreesByRepo ?? {})
        .flat()
        .find((worktree) => worktree.id === worktreeId)?.createdWithAgent
}

/** The tab an unchosen workspace shows by default, among `tabs` in tab order. */
export function desktopCreationDefaultTab(
  state: DesktopChoiceState,
  worktreeId: string,
  tabs: readonly Tab[]
): Tab | undefined {
  const createdWithAgent = unchosenCreationAgent(state, worktreeId)
  const terminals = state.tabsByWorktree?.[worktreeId] ?? []
  return resolveWorkspaceViewerTab(
    tabs,
    { chosenTabId: desktopChosenTabId(state, worktreeId), createdWithAgent },
    {
      idOf: (tab) => tab.id,
      agentOf: (tab) =>
        tab.contentType === 'terminal'
          ? terminals.find((terminal) => terminal.id === tab.entityId)?.launchAgent
          : tab.agentSessionAgent
    }
  )
}

/** Feed the same chat/terminal default into the snapshot's coherent display projection. */
export function arrivingCreationTab(
  state: DesktopChoiceState,
  worktreeId: string,
  snapshot: { tabs: readonly RuntimeMobileSessionClientTab[] }
): RuntimeMobileSessionClientTab | null {
  const createdWithAgent = unchosenCreationAgent(state, worktreeId)
  const chosenId = desktopChosenTabId(state, worktreeId)
  const chosen = chosenId
    ? snapshot.tabs.find(
        (tab) =>
          tab.id === chosenId ||
          (tab.type === 'terminal'
            ? tab.parentTabId === toHostSessionTabId(chosenId)
            : tab.type === 'agent-session' &&
              structuredAgentSessionTabId(tab.sessionId) === chosenId)
      )
    : undefined
  return (
    chosen ??
    resolveWorkspaceViewerTab(
      snapshot.tabs,
      { chosenTabId: chosenId, createdWithAgent },
      SESSION_TAB_IDENTITY
    ) ??
    null
  )
}
