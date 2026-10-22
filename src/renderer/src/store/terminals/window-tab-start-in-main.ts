// Layout-owner build: a new tab the window draws has its first terminal started by main, under the
// window's ids, once main has written the tab; the pane waits and then attaches (D1b-1's wait).
// Starts main's create cannot yet carry keep the window's own spawn (ledger L252).

import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { collectLeafIds } from '../../../../shared/terminal-pane-layout-tree'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { isSupportedWindowsShellOverride } from '../../../../shared/windows-terminal-shell'
import { isWslShellName } from '../../../../shared/local-windows-terminal-runtime'
import type { AppState } from '../types'
import type { TerminalPaneStart } from './terminal-state'
import { getRemoteConnectionIdForWorktree, worktreeUsesWslPath } from './terminal-workspace-routing'
import { forgetMainStartedPane } from './main-started-pane-view'
import {
  handStartupToMain,
  takeStartupBackFromMain,
  windowTabStartupParams
} from './window-tab-start-request'

type StartStore = {
  getState: () => AppState
  setState: (patch: Partial<AppState>) => void
  subscribe: (listener: (state: AppState) => void) => () => void
}

/** Whether main starts this tab's first terminal: a local, plain tab with no terminal yet. */
export function windowTabStartsInMain(state: AppState, tab: TerminalTab): boolean {
  return (
    !tab.ptyId &&
    !tab.forceHostRuntime &&
    // An SSH row's pane never spawns: its reconnect overlay owns it, and the prompts stay here.
    !getRemoteConnectionIdForWorktree(state, tab.worktreeId) &&
    // A tab the window put in WSL keeps its spawn: main's runtime read disagrees on two shapes.
    !worktreeUsesWslPath(state, tab.worktreeId) &&
    !isWslShellName(tab.shellOverride) &&
    (tab.shellOverride === undefined || isSupportedWindowsShellOverride(tab.shellOverride))
  )
}

/**
 * Shows the pane as starting at once, so it waits for main's terminal instead of spawning its
 * own. Returns the mark, which `startWindowTabInMain` or a refusal later takes back.
 */
export function markWindowTabStarting(
  store: Pick<StartStore, 'getState' | 'setState'>,
  tabId: string,
  leafId: string
): TerminalPaneStart {
  const mark: TerminalPaneStart = { status: 'starting' }
  const starts = store.getState().terminalPaneStartsByPaneKey
  store.setState({ terminalPaneStartsByPaneKey: { ...starts, [makePaneKey(tabId, leafId)]: mark } })
  return mark
}

/** Drops the window's own mark, unless main's frame replaced it. */
export function clearWindowTabMark(
  store: Pick<StartStore, 'getState' | 'setState'>,
  paneKey: string,
  mark: TerminalPaneStart
): void {
  const starts = store.getState().terminalPaneStartsByPaneKey
  if (starts[paneKey] !== mark) {
    return
  }
  const { [paneKey]: _mark, ...rest } = starts
  store.setState({ terminalPaneStartsByPaneKey: rest })
}

/**
 * Asks main to start the tab's first terminal, with the startup the tab was made with. The mark
 * stays until the pane can attach: main's binding is drawn, or main's own status took over.
 */
export function startWindowTabInMain(
  store: StartStore,
  tab: TerminalTab,
  leafId: string,
  mark: TerminalPaneStart
): void {
  const state = store.getState()
  const paneKey = makePaneKey(tab.id, leafId)
  const startup = state.pendingStartupByTabId[tab.id]
  const cwd = state.pendingInitialCwdByTabId[tab.id] ?? tab.startupCwd
  if (startup) {
    // Main runs it; a later mount of the pane must not run it again.
    const { [tab.id]: _started, ...pendingStartupByTabId } = state.pendingStartupByTabId
    store.setState({ pendingStartupByTabId })
  }
  handStartupToMain(tab.worktreeId, tab.id, paneKey, startup)
  void callRuntimeRpc<{ terminal: { ptyId: string } }>({ kind: 'local' }, 'terminal.create', {
    worktree: `id:${tab.worktreeId}`,
    windowTab: true,
    tabId: tab.id,
    leafId,
    ...(cwd ? { cwd } : {}),
    ...(tab.shellOverride ? { shell: tab.shellOverride } : {}),
    ...windowTabStartupParams(startup)
  }).then(
    (reply) => releaseOnceDrawn(store, tab.id, leafId, reply?.terminal?.ptyId ?? null, mark),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'host_not_owned') {
        takeStartupBackFromMain(tab.worktreeId, tab.id, paneKey, startup)
        // Main started nothing and does not hold the tab: the pane starts its own, as before.
        // Not for a tab the user closed meanwhile: nothing would ever take the startup back.
        if (startup && store.getState().terminalLayoutsByTabId[tab.id]) {
          store.setState({
            pendingStartupByTabId: { ...store.getState().pendingStartupByTabId, [tab.id]: startup }
          })
        }
        clearWindowTabMark(store, paneKey, mark)
        return
      }
      if (message === 'terminal_pane_owner_changed') {
        // Another owner's terminal runs in the pane; it attaches to that one, which never ran this.
        forgetMainStartedPane(paneKey)
        clearWindowTabMark(store, paneKey, mark)
        return
      }
      // Not given back: main's start may have run it before failing, and a second run is worse.
      // Main kept the pane, failed with why; its frame shows the same until then.
      const starts = store.getState().terminalPaneStartsByPaneKey
      if (starts[paneKey] === mark) {
        store.setState({
          terminalPaneStartsByPaneKey: {
            ...starts,
            [paneKey]: { status: 'failed', reason: message }
          }
        })
      }
    }
  )
}

/**
 * Keeps the mark until the pane can attach: any binding main draws for it (its start, or a later
 * rebind), main's own status replacing the mark, or the pane leaving the window.
 */
function releaseOnceDrawn(
  store: StartStore,
  tabId: string,
  leafId: string,
  ptyId: string | null,
  mark: TerminalPaneStart
): void {
  const paneKey = makePaneKey(tabId, leafId)
  const settled = (state: AppState): boolean => {
    const layout = state.terminalLayoutsByTabId[tabId]
    return (
      ptyId === null ||
      state.terminalPaneStartsByPaneKey[paneKey] !== mark ||
      Boolean(layout?.ptyIdsByLeafId?.[leafId]) ||
      !layout ||
      !collectLeafIds(layout.root).includes(leafId)
    )
  }
  if (settled(store.getState())) {
    clearWindowTabMark(store, paneKey, mark)
    return
  }
  const unsubscribe = store.subscribe((state) => {
    if (settled(state)) {
      unsubscribe()
      clearWindowTabMark(store, paneKey, mark)
    }
  })
}
