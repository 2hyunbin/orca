// Layout-owner build: main starts the pane and resumes its agent, so the window's "session
// restored" or "resume unavailable" banner comes from the outcome main publishes for that start.

import { useAppStore } from '@/store'
import type { TerminalPaneResumeOutcome } from '@/store/terminals/terminal-state'
import { mainStartsPane } from './main-starts-pane'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Starts whose banner this window showed: a remount or second attach shows none. */
const shownStarts = new Set<string>()
const watching = new WeakMap<ConnectPanePtySession, () => void>()

const startOf = ({ ptyId, ptyGeneration }: TerminalPaneResumeOutcome): string =>
  `${ptyId}#${ptyGeneration ?? ''}`

/**
 * After the view attached `ptyId`: shows the banner of main's start of that terminal, once, now or
 * when its outcome arrives. An outcome for another terminal shows nothing.
 */
export function showMainPaneResumeOutcome(session: ConnectPanePtySession, ptyId: string): void {
  if (!mainStartsPane(session)) {
    return
  }
  watching.get(session)?.()
  const shown = (outcomes: Record<string, TerminalPaneResumeOutcome>): boolean => {
    const found = outcomes[session.cacheKey]
    if (found?.ptyId !== ptyId) {
      return false
    }
    if (!shownStarts.has(startOf(found))) {
      shownStarts.add(startOf(found))
      session.showSessionRestoredBanner(found.outcome)
    }
    return true
  }
  let seen = useAppStore.getState().terminalPaneResumeOutcomesByPaneKey
  if (shown(seen)) {
    return
  }
  // Why wait: main's outcome can land in a frame after the one that bound the pane.
  const stop = (): void => {
    unsubscribe()
    watching.delete(session)
    const index = session.waitTeardowns.indexOf(stop)
    if (index !== -1) {
      session.waitTeardowns.splice(index, 1)
    }
  }
  const unsubscribe = useAppStore.subscribe((state) => {
    const outcomes = state.terminalPaneResumeOutcomesByPaneKey
    if (outcomes === seen) {
      return
    }
    seen = outcomes
    if (session.disposed || shown(outcomes)) {
      stop()
    }
  })
  watching.set(session, stop)
  session.waitTeardowns.push(stop)
}
