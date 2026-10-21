/**
 * Layout-owner builds: an `agent.launch` tab main wrote itself. The window makes no tab; it keeps
 * what it keeps for a launch tab it made (the launch's pane, whose outcome it shows, the prompt
 * that pane offers to copy, and whose view moves), on the tab main's frame draws. A workspace the
 * window does not draw yet gets these when its tab first draws, outcome included.
 */

import type { AgentLaunchPaneVerdictEvent } from '../../../shared/agent-launch-pane-verdict'
import type {
  AgentLaunchTabPublished,
  AgentLaunchTabPublishRequest
} from '../../../shared/agent-launch-tab-publication'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { useAppStore } from '../store'
import { presentAgentLaunchTab } from './agent-launch-tab-presentation'
import {
  forgetAgentLaunchPanePrompt,
  rememberAgentLaunchPanePrompt
} from './agent-launch-pane-prompt'
import { revealWorkspaceSurface } from './workspace-surface-reveal'

type LaunchPane = NonNullable<TerminalTab['agentLaunchPane']>

/** Launch panes of main's tabs this window does not draw yet, by tab id. */
const undrawn = new Map<string, { pane: LaunchPane; present: () => void; stop: () => void }>()

function drawnTab(worktreeId: string, tabId: string): TerminalTab | undefined {
  return useAppStore.getState().tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
}

function launchPaneOf(request: AgentLaunchTabPublishRequest): LaunchPane {
  return {
    leafId: request.leafId,
    ...(request.operationId ? { operationId: request.operationId } : {})
  }
}

/** As for a tab this window made: a retry of the same launch keeps what the tab says about it. */
function keepLaunchPane(tabId: string, kept: TerminalTab, pane: LaunchPane): void {
  const previous = kept.agentLaunchPane
  if (previous?.leafId === pane.leafId && previous.operationId === pane.operationId) {
    return
  }
  useAppStore.getState().setTabAgentLaunchPane(tabId, pane, {
    remount: previous?.leafId === pane.leafId && previous.outcome !== undefined
  })
}

function keepWhenDrawn(request: AgentLaunchTabPublishRequest, present: () => void): void {
  const { worktreeId, tabId } = request
  undrawn.get(tabId)?.stop()
  const stop = useAppStore.subscribe(() => {
    const tab = drawnTab(worktreeId, tabId)
    if (!tab) {
      return
    }
    const entry = undrawn.get(tabId)
    undrawn.delete(tabId)
    stop()
    if (entry) {
      keepLaunchPane(tabId, tab, entry.pane)
      entry.present()
    }
  })
  undrawn.set(tabId, { pane: launchPaneOf(request), present, stop })
}

export function keepAgentLaunchTabMainWrote(
  request: AgentLaunchTabPublishRequest
): AgentLaunchTabPublished {
  const { worktreeId, tabId, leafId, viewer } = request
  const created = request.shownByMain?.created === true
  if (request.prompt) {
    rememberAgentLaunchPanePrompt(tabId, request.prompt)
  }
  // Only the launch that made the tab moves anyone, as the window's own publication.
  const present = (): void => {
    if (created) {
      presentAgentLaunchTab(viewer, worktreeId, tabId, leafId)
    }
  }
  const tab = drawnTab(worktreeId, tabId)
  if (tab) {
    keepLaunchPane(tabId, tab, launchPaneOf(request))
    present()
  } else if (created && viewer === 'focus-window') {
    // The reveal draws the workspace; the tab shows once its frame lands.
    revealWorkspaceSurface(useAppStore.getState(), worktreeId, [tabId])
    keepWhenDrawn(request, present)
  } else {
    // Nobody is moved to an undrawn workspace; its tab keeps the launch when it draws.
    keepWhenDrawn(request, () => {})
  }
  const groupId =
    useAppStore
      .getState()
      .unifiedTabsByWorktree[worktreeId]?.find((entry) => entry.entityId === tabId)?.groupId ?? ''
  return { tabId, created, placement: { groupId } }
}

/**
 * A verdict for a launch pane whose tab this window does not draw yet: kept with it, so the tab
 * shows the outcome when it draws. False when no such pane waits.
 */
export function applyVerdictToUndrawnLaunchTab(event: AgentLaunchPaneVerdictEvent): boolean {
  const entry = undrawn.get(event.tabId)
  if (entry?.pane.leafId !== event.leafId) {
    return false
  }
  const { verdict } = event
  if (verdict.kind === 'not-started' || verdict.kind === 'unconfirmed') {
    entry.pane = { ...entry.pane, outcome: verdict }
    return true
  }
  // Settled or taken back: nothing is left for the tab to say, nor its pane to offer.
  entry.stop()
  undrawn.delete(event.tabId)
  forgetAgentLaunchPanePrompt(event.tabId)
  return true
}

export function _resetUndrawnLaunchTabsForTests(): void {
  for (const entry of undrawn.values()) {
    entry.stop()
  }
  undrawn.clear()
}
