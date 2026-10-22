// Layout-owner build: view facts of a start main runs, by pane key, for the pane that attaches to it.

import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type MainStartedPaneView = {
  initialAgentStatus?: { agent: TuiAgent; prompt: string }
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: string
}

const MAX_PANES = 64
const viewsByPaneKey = new Map<string, MainStartedPaneView>()
// Only an explicit give-back hands a pane its startup again; an evicted view is not one.
const givenBackPaneKeys = new Set<string>()

/** Main starts this pane: its own spawn and startup paste must not run. */
export function noteMainStartsPane(paneKey: string, view: MainStartedPaneView): void {
  givenBackPaneKeys.delete(paneKey)
  viewsByPaneKey.delete(paneKey)
  viewsByPaneKey.set(paneKey, view)
  for (const oldest of viewsByPaneKey.keys()) {
    if (viewsByPaneKey.size <= MAX_PANES) {
      break
    }
    viewsByPaneKey.delete(oldest)
  }
}

/** The pane attaches to a terminal this start never ran: nothing of it applies. */
export function forgetMainStartedPane(paneKey: string): void {
  viewsByPaneKey.delete(paneKey)
}

/** Main declined: the pane starts its own terminal, with its startup, as before. */
export function giveBackMainStartedPane(paneKey: string): void {
  viewsByPaneKey.delete(paneKey)
  givenBackPaneKeys.add(paneKey)
  for (const oldest of givenBackPaneKeys) {
    if (givenBackPaneKeys.size <= MAX_PANES) {
      break
    }
    givenBackPaneKeys.delete(oldest)
  }
}

/** Once, when the waiting pane learns main gave its start back. */
export function takeMainGaveBackPane(paneKey: string): boolean {
  return givenBackPaneKeys.delete(paneKey)
}

export function peekMainStartedPaneView(paneKey: string): MainStartedPaneView | undefined {
  return viewsByPaneKey.get(paneKey)
}

/** Once, when the pane attaches to main's terminal. */
export function takeMainStartedPaneView(paneKey: string): MainStartedPaneView | undefined {
  const view = viewsByPaneKey.get(paneKey)
  viewsByPaneKey.delete(paneKey)
  return view
}

export function resetMainStartedPaneViewsForTests(): void {
  viewsByPaneKey.clear()
  givenBackPaneKeys.clear()
}
