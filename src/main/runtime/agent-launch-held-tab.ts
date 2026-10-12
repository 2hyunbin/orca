// An `agent.launch` tab shown before its agent exists (U8: the tab appears at once, with or without a
// window), and the launch's verdict on that pane. The runtime's layout holds the tab under the ids
// the spawn bakes into the agent's PTY, so the spawn binds this pane instead of making another.

import type { AgentLaunchPaneVerdictEvent } from '../../shared/agent-launch-pane-verdict'
import type {
  AgentLaunchTabPublished,
  AgentLaunchTabPublishRequest
} from '../../shared/agent-launch-tab-publication'
import { layoutContainsLeafId } from '../../shared/workspace-layout/terminal-pane-tree'
import { findTerminal } from '../../shared/workspace-layout/workspace-layout-command-steps'
import { paneKeyOf } from '../../shared/workspace-layout/workspace-layout-model'
import type { LayoutNavigateRequest } from '../../shared/workspace-layout/workspace-layout-stream-frames'
import type { PaneStart } from './runtime-pane-start-attempts'
import type { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'

export type AgentLaunchTabRequest = Omit<AgentLaunchTabPublishRequest, 'requestId'>

export type AgentLaunchTabHost = {
  holder: RuntimeWorkspaceLayouts
  /** The group the desktop view shows in a workspace, where a tab with no requested group joins. */
  desktopActiveGroup: (worktreeId: string) => { groupId?: string }
  focusInDesktopView: (worktreeId: string, target: { tabId: string; leafId?: string }) => void
  navigateDesktopView: (request: LayoutNavigateRequest) => void
}

function launchPaneFor(request: AgentLaunchTabRequest) {
  return {
    leafId: request.leafId,
    ...(request.operationId ? { operationId: request.operationId } : {})
  }
}

function groupOf(holder: RuntimeWorkspaceLayouts, worktreeId: string, tabId: string) {
  return holder.published(worktreeId)?.groups.find((group) => group.tabIds.includes(tabId))?.id
}

/**
 * Shows the launch's tab, or finds the one a retry of it names. Null when the runtime does not hold
 * the workspace's layout: the tab then appears when the agent spawns.
 */
export function showAgentLaunchTab(
  host: AgentLaunchTabHost,
  request: AgentLaunchTabRequest
): { published: AgentLaunchTabPublished; start: PaneStart | null } | null {
  const { holder } = host
  const { worktreeId, tabId, leafId } = request
  const hostId = holder.hostIdOf(worktreeId)
  if (!hostId || !holder.published(worktreeId)) {
    return null
  }
  const existing = holder.findTerminalTab(tabId)
  if (existing) {
    // A retry naming the same tab: never a second one, and never another workspace's tab.
    if (existing.workspace !== worktreeId) {
      throw new Error('agent_launch_tab_id_taken')
    }
    const groupId = groupOf(holder, worktreeId, existing.tabId)
    if (!groupId) {
      throw new Error('agent_launch_tab_unplaced')
    }
    const kept = findTerminal(holder.model(hostId)!.workspaces[worktreeId]!, existing.tabId)
      ?.terminal.agentLaunchPane
    // A different launch into this pane: what an earlier one left on it no longer stands.
    if (kept?.leafId !== leafId || kept.operationId !== request.operationId) {
      holder.transition(hostId, {
        type: 'agentLaunchPaneSet',
        workspace: worktreeId,
        tabId: existing.tabId,
        agentLaunchPane: launchPaneFor(request)
      })
    }
    return { published: { tabId, created: false, placement: { groupId } }, start: null }
  }
  const requestedGroupId = request.placement?.groupId
  const applied = holder.apply(
    {
      type: 'createTerminalTab',
      workspace: worktreeId,
      tabId,
      leafId,
      ...(requestedGroupId ? { groupId: requestedGroupId } : host.desktopActiveGroup(worktreeId)),
      ...(request.placement?.afterTabId ? { afterTabId: request.placement.afterTabId } : {}),
      viewMode: request.viewMode,
      creation: { launchAgent: request.launchAgent, agentLaunchPane: launchPaneFor(request) }
    },
    hostId
  )
  if (!applied.ok) {
    throw new Error(applied.code)
  }
  const landed = groupOf(holder, worktreeId, tabId) ?? ''
  const anchored =
    request.placement?.afterTabId !== undefined &&
    groupOf(holder, worktreeId, request.placement.afterTabId) === landed
  const fallback =
    requestedGroupId !== undefined
      ? landed === requestedGroupId
        ? undefined
        : anchored
          ? 'anchor-group'
          : 'active-group'
      : request.placement?.afterTabId !== undefined && !anchored
        ? 'active-group'
        : undefined
  showLaunchTab(host, request)
  return {
    published: {
      tabId,
      created: true,
      placement: { groupId: landed, ...(fallback ? { fallback } : {}) }
    },
    start: applied.starts?.[0] ?? null
  }
}

/** Whose screen moves (`AgentLaunchTabViewerRule`): the desktop view, which paired clients follow. */
function showLaunchTab(host: AgentLaunchTabHost, request: AgentLaunchTabRequest): void {
  const { worktreeId, tabId, leafId, viewer } = request
  if (viewer === 'none') {
    return
  }
  host.focusInDesktopView(worktreeId, { tabId, leafId })
  if (viewer === 'focus-window') {
    host.navigateDesktopView({
      kind: 'focusPane',
      workspace: worktreeId,
      paneKey: paneKeyOf(tabId, leafId)
    })
  }
}

/**
 * A launch pane's fate: the tab keeps a final one, forgets a settled one, and a withdrawn pane leaves
 * (the pane alone when the user split the tab while it waited). Only a pane the tab says a launch
 * laid out is touched.
 */
export function applyAgentLaunchPaneVerdict(
  holder: RuntimeWorkspaceLayouts,
  event: AgentLaunchPaneVerdictEvent
): void {
  const location = holder.findTerminalTab(event.tabId)
  if (!location || location.workspace !== event.worktreeId) {
    return
  }
  const { hostId, workspace, tabId } = location
  const tab = findTerminal(holder.model(hostId)!.workspaces[workspace]!, tabId)
  const launch = tab?.terminal.agentLaunchPane
  if (!tab || launch?.leafId !== event.leafId) {
    return
  }
  const setLaunchPane = (agentLaunchPane: typeof launch | null): void => {
    holder.transition(hostId, { type: 'agentLaunchPaneSet', workspace, tabId, agentLaunchPane })
  }
  const { verdict } = event
  switch (verdict.kind) {
    case 'proceed':
      setLaunchPane(null)
      return
    case 'not-started':
    case 'unconfirmed':
      // A pane the user closed has nothing left for the outcome to describe.
      setLaunchPane(
        layoutContainsLeafId(tab.panes.root, event.leafId) ? { ...launch, outcome: verdict } : null
      )
      return
    case 'withdrawn':
      if (tab.panes.root?.type === 'leaf') {
        holder.apply({ type: 'closeTabs', workspace, tabIds: [tabId], force: true }, hostId)
        return
      }
      setLaunchPane(null)
      holder.apply({ type: 'closePane', workspace, tabId, leafId: event.leafId }, hostId)
  }
}

/** The launch tabs this runtime showed, each with the start its verdict ends if nothing spawned. */
export class AgentLaunchHeldTabs {
  private readonly starts = new Map<string, { worktreeId: string; start: PaneStart }>()

  constructor(private readonly host: AgentLaunchTabHost) {}

  show(request: AgentLaunchTabRequest): AgentLaunchTabPublished | null {
    const shown = showAgentLaunchTab(this.host, request)
    if (shown?.start) {
      this.starts.set(shown.start.paneKey, { worktreeId: request.worktreeId, start: shown.start })
    }
    return shown?.published ?? null
  }

  verdict(event: AgentLaunchPaneVerdictEvent): void {
    const { holder } = this.host
    const paneKey = paneKeyOf(event.tabId, event.leafId)
    const shown = this.starts.get(paneKey)
    this.starts.delete(paneKey)
    const hostId = holder.hostIdOf(event.worktreeId)
    if (shown && hostId) {
      const final = event.verdict.kind === 'not-started' || event.verdict.kind === 'unconfirmed'
      holder.endStart(hostId, shown.worktreeId, shown.start, final ? 'failed' : null)
    }
    applyAgentLaunchPaneVerdict(holder, event)
  }
}
