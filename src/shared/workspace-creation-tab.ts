import type { RuntimeMobileSessionClientTab } from './runtime-mobile-session-tab-contracts'

/**
 * The tab a workspace was created for: the first tab running the agent it was created with.
 * Derived from the saved `createdWithAgent` and each tab's own agent, so nothing extra is stored and
 * closing that tab retires the default by itself.
 */
export function findWorkspaceCreationTab<T>(
  tabs: readonly T[],
  createdWithAgent: string | undefined,
  agentOf: (tab: T) => string | undefined
): T | undefined {
  return createdWithAgent ? tabs.find((tab) => agentOf(tab) === createdWithAgent) : undefined
}

export type WorkspaceViewerTabIdentity<T> = {
  idOf: (tab: T) => string
  agentOf: (tab: T) => string | undefined
}

/**
 * The tab one viewer (a desktop window or a paired device) shows for a workspace: its explicit
 * choice while that tab exists; with no choice, the workspace's creation tab. Undefined leaves the
 * viewer's own topology fallback. The result is display only and is never recorded as a choice,
 * so a Setup tab shown before the agent exists gives way to the agent when it arrives.
 */
export function resolveWorkspaceViewerTab<T>(
  tabs: readonly T[],
  view: { chosenTabId: string | null | undefined; createdWithAgent: string | undefined },
  identity: WorkspaceViewerTabIdentity<T>
): T | undefined {
  if (view.chosenTabId) {
    return tabs.find((tab) => identity.idOf(tab) === view.chosenTabId)
  }
  return findWorkspaceCreationTab(tabs, view.createdWithAgent, identity.agentOf)
}

/** A host session snapshot's tabs: a chat names its agent, an agent terminal its launch agent. */
export const SESSION_TAB_IDENTITY: WorkspaceViewerTabIdentity<RuntimeMobileSessionClientTab> = {
  idOf: (tab) => tab.id,
  agentOf: (tab) =>
    tab.type === 'agent-session' ? tab.agent : tab.type === 'terminal' ? tab.launchAgent : undefined
}
