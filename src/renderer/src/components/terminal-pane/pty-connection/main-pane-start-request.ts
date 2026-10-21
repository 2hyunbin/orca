// Layout-owner build: a pane with no live terminal is started by main, never by the window. The
// window asks, waits for main's start to end, then attaches to the terminal main bound.

import { useAppStore } from '@/store'
import { sendLayoutApply } from '@/runtime/layout-apply-send'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import { recordPtyConnectDiagnostic } from './pty-connect-limits'
import { adoptMainBinding, waitsForMainPaneStart } from './main-pane-start-wait'
import { startDeferredSessionReattach } from './deferred-session-reattach-connect'
import { holdForNewerDaemon } from './newer-daemon-hold-pane'
import type { HeldPaneReopenOutcome } from '../newer-daemon-hold-state'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Whether main starts this pane's terminal: a layout-owner build, and main owns the workspace. */
export function mainStartsPane(session: {
  deps: ConnectPanePtySession['deps']
  runtimeEnvironmentId?: string | null
}): boolean {
  return (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    !session.runtimeEnvironmentId &&
    !runtimeEnvironmentIdUnlessTwin(useAppStore.getState(), session.deps.worktreeId)
  )
}

type MainPaneStartHandlers = {
  /** Runs once main's start for the pane ends: the pane is bound to its terminal. */
  attach: () => void
  /** Main handed a twin's start back: start it as today. */
  today?: () => void
  refused?: () => void
}

/**
 * Asks main to start the pane, then attaches once main's start for it ends. False when main does
 * not own the pane's layout (a paired server's workspace), which keeps today's path.
 */
export function startPaneThroughMain(
  session: ConnectPanePtySession,
  handlers: MainPaneStartHandlers
): boolean {
  const tabId = parsePaneKey(session.cacheKey)?.tabId
  if (!tabId) {
    return false
  }
  recordPtyConnectDiagnostic(`pane=${session.pane.id} -> START THROUGH MAIN`)
  const refused = (code: string): void => {
    showStartRefusal(session, code)
    handlers.refused?.()
  }
  return sendLayoutApply(
    useAppStore.getState(),
    session.deps.worktreeId,
    { type: 'startPane', tabId, paneKey: session.cacheKey },
    {
      // Main's reply lands after the frame that shows the pane starting, or bound when it was live.
      apply: () => {
        if (session.disposed || waitsForMainPaneStart(session, handlers.attach)) {
          return
        }
        adoptMainBinding(session, useAppStore.getState())
        handlers.attach()
      },
      asToday: handlers.today ?? (() => refused('host_not_owned')),
      refused
    }
  )
}

function showStartRefusal(session: ConnectPanePtySession, code: string): void {
  if (!session.disposed) {
    session.deps.onPtyErrorRef?.current?.(session.pane.id, `The terminal could not start: ${code}`)
  }
}

/**
 * Layout-owner build: the window's own start of a pane (a wake, a hibernated agent's wake, a
 * restart replacement, a reattach that found its terminal gone) asks main instead, then attaches
 * to the terminal main bound. `today` starts it when main does not start this pane.
 */
export function startPaneThroughMainThenAttach(
  session: ConnectPanePtySession,
  today: () => Promise<string | null>
): Promise<string | null> {
  if (!mainStartsPane(session)) {
    return today()
  }
  if (session.mainStartAttachPending) {
    // Why: the attach to main's own start found no terminal; asking again would loop on a pane
    // whose terminal ends at once.
    session.mainStartAttachPending = false
    showStartRefusal(session, 'pty_exited')
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    const settleNull = (): void => resolve(null)
    session.waitTeardowns.push(settleNull)
    const sent = startPaneThroughMain(session, {
      attach: () => {
        const ptyId = session.deps.restoredPtyIdByLeafId?.[session.pane.leafId] ?? null
        if (ptyId) {
          session.mainStartAttachPending = true
          startDeferredSessionReattach(session, ptyId)
        }
        resolve(ptyId)
      },
      today: () => resolve(today()),
      refused: settleNull
    })
    if (!sent) {
      resolve(today())
    }
  })
}

/** Main's restore statuses that need a view to start the pane: its first view is the wake. */
const RESTORE_FROM_STATUSES = new Set(['sleeping', 'held'])

/**
 * Layout-owner build, at connect: whether main's start of the pane (under way, or one this view
 * asks for) stands in for the window's own. A sleeping pane is started on its first view; a held
 * pane shows today's held screen and starts once the user reopens it. `connect` attaches after.
 */
export function defersToMainPaneStart(
  session: ConnectPanePtySession,
  connect: () => void
): boolean {
  if (waitsForMainPaneStart(session, connect)) {
    return true
  }
  if (!mainStartsPane(session) || session.mainPaneStartHandedBack) {
    return false
  }
  const start = useAppStore.getState().terminalPaneStartsByPaneKey[session.cacheKey]
  if (!start || !RESTORE_FROM_STATUSES.has(start.status)) {
    return false
  }
  if (start.status === 'held') {
    const boundPtyId = session.deps.restoredPtyIdByLeafId?.[session.pane.leafId]
    holdForNewerDaemon(session, boundPtyId ?? session.cacheKey, () =>
      startHeldPaneThroughMain(session, connect)
    )
    return true
  }
  const startOnView = (): void => {
    session.mainPaneStartOnReveal = null
    const today = (): void => {
      session.mainPaneStartHandedBack = true
      connect()
    }
    if (!startPaneThroughMain(session, { attach: connect, today })) {
      today()
    }
  }
  if (session.deps.isVisibleRef.current) {
    startOnView()
  } else {
    // Why: a hidden pane waits for its first view, as a hidden sleeping agent does (#29459).
    session.mainPaneStartOnReveal = startOnView
  }
  return true
}

/** A held pane's reopen: main starts it, and the outcome says whether it came back. */
function startHeldPaneThroughMain(
  session: ConnectPanePtySession,
  connect: () => void
): Promise<HeldPaneReopenOutcome> {
  const agentResumed = Boolean(session.buildColdRestoreAgentResumeStartup())
  return new Promise((resolve) => {
    const sent = startPaneThroughMain(session, {
      attach: () => {
        connect()
        resolve({ reopened: true, agentResumed })
      },
      refused: () => resolve({ reopened: false, agentResumed: false })
    })
    if (!sent) {
      resolve({ reopened: false, agentResumed: false })
    }
  })
}
