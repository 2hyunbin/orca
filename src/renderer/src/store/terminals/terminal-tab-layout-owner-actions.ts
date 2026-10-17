import type { AppState } from '../types'
import {
  applyGeneratedTabTitleUpdates,
  type GeneratedTabTitleUpdate
} from '../slices/terminal-tab-title-batch'
import { getTerminalTabOwnerWorktreeId } from '../slices/terminal-tab-owner-index'
import type { TerminalSlice, TerminalStoreGet } from './terminal-state'
import { sendTerminalTabChangesToLayoutOwner } from './tab-change-through-layout-owner'

type RoutedActions = Pick<
  TerminalSlice,
  | 'setTabCustomTitle'
  | 'setTabColor'
  | 'setAiVaultTabTitle'
  | 'setGeneratedTabTitleFromAgentPrompt'
  | 'setGeneratedTabTitlesFromAgentPrompts'
  | 'clearTabLaunchAgent'
>

type Changes = Parameters<typeof sendTerminalTabChangesToLayoutOwner>[1]

function terminalTab(state: AppState, tabId: string) {
  const owner = getTerminalTabOwnerWorktreeId(state.tabsByWorktree, tabId)
  return owner ? state.tabsByWorktree[owner]?.find((tab) => tab.id === tabId) : undefined
}

/** The generated titles the window would give its tabs, one rename each. */
function generatedTitleChanges(state: AppState, updates: readonly GeneratedTabTitleUpdate[]) {
  const patched = applyGeneratedTabTitleUpdates(state, updates).patch?.tabsByWorktree ?? {}
  const changes: Changes[number][] = []
  for (const tabs of Object.values(patched)) {
    for (const tab of tabs) {
      const title = tab.generatedTitle ?? null
      if (title !== (terminalTab(state, tab.id)?.generatedTitle ?? null)) {
        changes.push({
          tabId: tab.id,
          change: (id) => ({ type: 'renameTab', tabId: id, kind: 'generated', title })
        })
      }
    }
  }
  return changes
}

/**
 * A layout-owner build's terminal tab changes from any caller (CLI rename, templates, agent
 * titles, an ended launch agent): main changes its copy first, then the window's own action shows
 * the same change. Before this, only the tab bar's rename and color reached main; the rest reached
 * it only through the window's session save.
 */
export function routeTerminalTabChangesThroughLayoutOwner(
  actions: RoutedActions,
  get: TerminalStoreGet
): RoutedActions {
  const route = (changes: Changes, local: () => void): void =>
    sendTerminalTabChangesToLayoutOwner(get(), changes, local)
  return {
    setTabCustomTitle: (tabId, title, opts) =>
      route(
        [{ tabId, change: (id) => ({ type: 'renameTab', tabId: id, kind: 'custom', title }) }],
        () => actions.setTabCustomTitle(tabId, title, opts)
      ),
    setTabColor: (tabId, color) =>
      route([{ tabId, change: (id) => ({ type: 'setTabProps', tabId: id, color }) }], () =>
        actions.setTabColor(tabId, color)
      ),
    setAiVaultTabTitle: (tabId, title) => {
      const current = terminalTab(get(), tabId)?.aiVaultTitle ?? null
      const changed = JSON.stringify(current) !== JSON.stringify(title ?? null)
      route(
        changed
          ? [{ tabId, change: (id) => ({ type: 'renameTab', tabId: id, kind: 'aiVault', title }) }]
          : [],
        () => actions.setAiVaultTabTitle(tabId, title)
      )
    },
    setGeneratedTabTitleFromAgentPrompt: (paneKey, prompt, options) =>
      route(generatedTitleChanges(get(), [{ paneKey, prompt, options }]), () =>
        actions.setGeneratedTabTitleFromAgentPrompt(paneKey, prompt, options)
      ),
    setGeneratedTabTitlesFromAgentPrompts: (updates) =>
      route(generatedTitleChanges(get(), updates), () =>
        actions.setGeneratedTabTitlesFromAgentPrompts(updates)
      ),
    clearTabLaunchAgent: (tabId) =>
      route(
        terminalTab(get(), tabId)?.launchAgent
          ? [
              {
                tabId,
                change: (id) => ({ type: 'setTabProps', tabId: id, clearLaunchAgent: true })
              }
            ]
          : [],
        () => actions.clearTabLaunchAgent(tabId)
      )
  }
}
