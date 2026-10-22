// Layout-owner build: main starts the pane and resumes its agent, so the window's "session
// restored" or "resume unavailable" banner comes from the outcome main publishes for that start.

import { useAppStore } from '@/store'
import type { TerminalPaneResumeOutcome } from '@/store/terminals/terminal-state'
import { mainStartsPane } from './main-starts-pane'
import { resolveTerminalTabId } from './terminal-tab-id'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { PtyConnectResult } from '../pty-transport-types'

type Outcomes = Record<string, TerminalPaneResumeOutcome>
type AppState = ReturnType<typeof useAppStore.getState>

// Why session storage: a reload reattaches the same start, which showed its banner already.
const SHOWN_STARTS_KEY = 'orca.mainPaneResumeBannersShown'
/** This document's shown starts, for when session storage is unavailable. */
const shownHere = new Set<string>()
const watching = new WeakMap<ConnectPanePtySession, () => void>()

const startOf = ({ ptyId, ptyGeneration }: TerminalPaneResumeOutcome): string =>
  `${ptyId}#${ptyGeneration ?? ''}`

function readShownStarts(): string[] {
  try {
    const stored: unknown = JSON.parse(globalThis.sessionStorage.getItem(SHOWN_STARTS_KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter((key) => typeof key === 'string') : []
  } catch {
    return []
  }
}

/** Notes `start` as shown, keeping only starts main still publishes; false if it was already. */
function noteShown(start: string, outcomes: Outcomes): boolean {
  const shown = readShownStarts()
  if (shownHere.has(start) || shown.includes(start)) {
    return false
  }
  shownHere.add(start)
  const live = new Set(Object.values(outcomes).map(startOf))
  try {
    globalThis.sessionStorage.setItem(
      SHOWN_STARTS_KEY,
      JSON.stringify([...shown.filter((key) => live.has(key)), start])
    )
  } catch {
    // Best effort: without storage a reload may show the banner once more.
  }
  return true
}

/** The terminal the store binds the view's pane to now. */
function boundPtyId(session: ConnectPanePtySession, state: AppState): string | undefined {
  const tabId = resolveTerminalTabId(state, session.deps.tabId)
  return state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[session.pane.leafId]
}

/**
 * Whether the pane's attach to `ptyId` resumed its agent: the window's own resume, unless the
 * spawn said it could not, or, when main started the pane (`windowResume` null), main's outcome,
 * which rides the frame binding `ptyId`.
 */
export function attachResumedAgent(
  session: ConnectPanePtySession,
  ptyId: string,
  windowResume: ColdRestoreAgentResumeStartup | null,
  connected?: PtyConnectResult | string | void
): boolean {
  if (!mainStartsPane(session) || windowResume) {
    const unavailable = typeof connected === 'object' && connected.agentResumeUnavailable
    return Boolean(windowResume) && !unavailable
  }
  const found = useAppStore.getState().terminalPaneResumeOutcomesByPaneKey[session.cacheKey]
  return found?.ptyId === ptyId && found.outcome === 'restored'
}

/**
 * After the view attached `ptyId`: shows the banner of main's start of that terminal, once, now or
 * when its outcome arrives. An outcome for another terminal shows nothing.
 */
export function showMainPaneResumeOutcome(session: ConnectPanePtySession, ptyId: string): void {
  if (!mainStartsPane(session)) {
    return
  }
  watching.get(session)?.()
  const shown = (outcomes: Outcomes): boolean => {
    const found = outcomes[session.cacheKey]
    if (found?.ptyId !== ptyId) {
      return false
    }
    if (noteShown(startOf(found), outcomes)) {
      session.showSessionRestoredBanner(found.outcome)
    }
    return true
  }
  let seen = useAppStore.getState()
  if (shown(seen.terminalPaneResumeOutcomesByPaneKey)) {
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
    if (
      state.terminalPaneResumeOutcomesByPaneKey === seen.terminalPaneResumeOutcomesByPaneKey &&
      state.terminalLayoutsByTabId === seen.terminalLayoutsByTabId
    ) {
      return
    }
    seen = state
    const bound = boundPtyId(session, state)
    // A pane bound to another terminal since will never show this start's outcome.
    if (
      session.disposed ||
      shown(state.terminalPaneResumeOutcomesByPaneKey) ||
      (bound && bound !== ptyId)
    ) {
      stop()
    }
  })
  watching.set(session, stop)
  session.waitTeardowns.push(stop)
}
