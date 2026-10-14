import { resolveAutoAckTabTargets, type AutoAckTabTarget } from './agent-auto-ack-targets'
import {
  captureAgentSubjectReads,
  sameStructuredReadTarget,
  type AgentSubjectRead,
  type StructuredSubjectRead
} from '@/attention/agent-subject-read-actions'
import { createAutoAckPresenceCheck } from './agent-auto-ack-presence'
import type { AppState } from '@/store/types'
import { selectFloatingWorkspacePanelVisible } from '@/store/floating-workspace-panel-selector'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  acknowledgeViewedAutoAckTarget,
  readAgentAttentionTurnRecords,
  surfaceForAutoAckTarget
} from './agent-auto-ack-surfaces'
import {
  computeAgentAcknowledgementTargets,
  computeLapsedManualUnreadProtections
} from '@/attention/agent-attention-acknowledgement'
import { isWorkspaceFlagSet } from '@/store/slices/workspace-attention/workspace-unread-flag'

type ScanStore = {
  getState: () => AppState
  subscribe: (listener: () => void) => () => void
}

/** The window the scan runs in; the hook binds the real document, tests bind a fake. */
export type ViewedAttentionEnvironment = {
  /** Orca's window is visible and focused. */
  isWindowOnScreen: () => boolean
  /** Null where there is no native idle capability (browsers): the window gate stands alone. */
  readDesktopAway: (() => Promise<boolean | undefined>) | null
  subscribeStructuredViews: (onView: (view: StructuredSubjectRead) => void) => () => void
  /** `onRescan`: visibility/focus changed. `onInput`: trusted input proves presence. */
  subscribePresenceSignals: (onRescan: () => void, onInput: () => void) => () => void
  /** Terminal keystrokes, which xterm stops before they reach the window. */
  subscribeTerminalInput: (onInput: () => void) => () => void
}

function hasMarkerOfTab(record: Record<string, unknown>, tabId: string): boolean {
  for (const key in record) {
    if (key.length > tabId.length && key.charCodeAt(tabId.length) === 58 && key.startsWith(tabId)) {
      return true
    }
  }
  return false
}

function hasMarkersOnScreen(s: AppState, targets: readonly AutoAckTabTarget[]): boolean {
  return targets.some(
    ({ tabId }) =>
      Boolean(s.unreadTerminalTabs[tabId]) ||
      hasMarkerOfTab(s.unreadTerminalPanes, tabId) ||
      hasMarkerOfTab(s.unreadAgentCompletionPanes, tabId)
  )
}

/**
 * On screen means read: while the window is visible and focused, the agents on the visible tabs
 * are acknowledged and every unread marker of those tabs is read.
 * Scans live + retained maps: Codex's title-revert (pty-connection.ts:onAgentExited) migrates `done` rows to retained mid-race — see docs/codex-agent-row-bold-stuck.md.
 */
export function startViewedAttentionScan(
  store: ScanStore,
  env: ViewedAttentionEnvironment
): () => void {
  // Why: the store uses plain create() (no subscribeWithSelector), so manually track the slices we depend on to skip unrelated updates.
  // Init to undefined so the first maybeAck() (on mount) always passes the ref guard and scans.
  let lastActiveView: unknown = undefined
  let lastActiveTabId: unknown = undefined
  let lastActiveWorktreeId: unknown = undefined
  let lastActiveWorkspaceGroupId: unknown = undefined
  let lastActiveWorkspaceGroups: unknown = undefined
  let lastFloatingWorkspaceActiveTabId: unknown = undefined
  let lastFloatingWorkspaceGroupId: unknown = undefined
  let lastFloatingWorkspaceGroups: unknown = undefined
  let lastAgentStatus: unknown = undefined
  let lastRetained: unknown = undefined
  let lastAcknowledged: unknown = undefined
  let lastLayouts: unknown = undefined
  let lastUnreadTerminalTabs: unknown = undefined
  let lastUnreadTerminalPanes: unknown = undefined
  let lastUnreadAgentCompletionPanes: unknown = undefined
  let lastFloatingPanelVisible = false
  // The screen last read; null after the window left the screen, so its return is an arrival.
  let lastReadScreenKey: string | null = null

  // `force` re-scans after a presence signal the store never sees.
  let pendingPresenceReads: readonly AgentSubjectRead[] | undefined
  const presence = createAutoAckPresenceCheck(
    async () => env.readDesktopAway?.(),
    () => {
      const reads = pendingPresenceReads
      pendingPresenceReads = undefined
      maybeAck({ force: true, presenceConfirmed: true, reads })
    }
  )
  const maybeAck = (options?: {
    force?: boolean
    presenceConfirmed?: boolean
    reads?: readonly AgentSubjectRead[]
    view?: StructuredSubjectRead
  }): void => {
    const s = store.getState()
    const activeWorktreeId = s.activeWorktreeId
    const activeWorkspaceGroupId = activeWorktreeId
      ? (s.activeGroupIdByWorktree[activeWorktreeId] ?? null)
      : null
    const activeWorkspaceGroups = activeWorktreeId
      ? s.groupsByWorktree[activeWorktreeId]
      : undefined
    const floatingWorkspaceActiveTabId =
      s.activeTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? null
    const floatingWorkspaceGroupId =
      s.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? null
    const floatingWorkspaceGroups = s.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
    // Why only the opening edge: opening puts an already-active floating tab on screen, so it
    // must scan; closing must not, or it would lapse a mark-unread on the tab the user left.
    const floatingPanelVisible = selectFloatingWorkspacePanelVisible(s)
    const floatingPanelOpened = floatingPanelVisible && !lastFloatingPanelVisible
    lastFloatingPanelVisible = floatingPanelVisible
    if (
      !options?.force &&
      !floatingPanelOpened &&
      s.activeView === lastActiveView &&
      s.activeTabId === lastActiveTabId &&
      activeWorktreeId === lastActiveWorktreeId &&
      activeWorkspaceGroupId === lastActiveWorkspaceGroupId &&
      activeWorkspaceGroups === lastActiveWorkspaceGroups &&
      floatingWorkspaceActiveTabId === lastFloatingWorkspaceActiveTabId &&
      floatingWorkspaceGroupId === lastFloatingWorkspaceGroupId &&
      floatingWorkspaceGroups === lastFloatingWorkspaceGroups &&
      s.agentStatusByPaneKey === lastAgentStatus &&
      s.retainedAgentsByPaneKey === lastRetained &&
      s.acknowledgedAgentsByPaneKey === lastAcknowledged &&
      s.terminalLayoutsByTabId === lastLayouts &&
      s.unreadTerminalTabs === lastUnreadTerminalTabs &&
      s.unreadTerminalPanes === lastUnreadTerminalPanes &&
      s.unreadAgentCompletionPanes === lastUnreadAgentCompletionPanes
    ) {
      return
    }

    // Presence signals force a rescan; unrelated writes must not retry an away result.
    lastActiveView = s.activeView
    lastActiveTabId = s.activeTabId
    lastActiveWorktreeId = activeWorktreeId
    lastActiveWorkspaceGroupId = activeWorkspaceGroupId
    lastActiveWorkspaceGroups = activeWorkspaceGroups
    lastFloatingWorkspaceActiveTabId = floatingWorkspaceActiveTabId
    lastFloatingWorkspaceGroupId = floatingWorkspaceGroupId
    lastFloatingWorkspaceGroups = floatingWorkspaceGroups
    lastAgentStatus = s.agentStatusByPaneKey
    lastRetained = s.retainedAgentsByPaneKey
    lastAcknowledged = s.acknowledgedAgentsByPaneKey
    lastLayouts = s.terminalLayoutsByTabId
    lastUnreadTerminalTabs = s.unreadTerminalTabs
    lastUnreadTerminalPanes = s.unreadTerminalPanes
    lastUnreadAgentCompletionPanes = s.unreadAgentCompletionPanes

    // Why: tab-active only proxies "seen"; gate on window visible+focused so away-time transitions don't silently clear the bold signal.
    if (!env.isWindowOnScreen()) {
      lastReadScreenKey = null
      return
    }
    const targets = resolveAutoAckTabTargets(s)
    // Why no protection reset here: zero targets just means nothing is on screen
    // (Settings, browser, an overlay) — a transient view switch must not lapse an
    // explicit mark-unread the user just made.
    if (targets.length === 0) {
      lastReadScreenKey = ''
      return
    }
    const screenKey = targets.map((target) => `${target.worktreeId}\n${target.tabId}`).join('\n\n')
    const arrived = screenKey !== lastReadScreenKey
    const reads =
      options?.reads ??
      captureAgentSubjectReads(
        targets.flatMap((target) => {
          const key = surfaceForAutoAckTarget(s, target).resolveViewedSubjectKey(target.tabId)
          return key ? [key] : []
        })
      ).map((read) => {
        const view = options?.view
        return view &&
          read.structured?.sessionId === view.sessionId &&
          sameStructuredReadTarget(read.structured.target, view.target)
          ? { ...read, structured: view }
          : read
      })
    if (!options?.presenceConfirmed && env.readDesktopAway !== null) {
      const records = readAgentAttentionTurnRecords(s)
      const hasAttention =
        hasMarkersOnScreen(s, targets) ||
        targets.some((target) => {
          const subjectKey = surfaceForAutoAckTarget(s, target).resolveViewedSubjectKey(
            target.tabId
          )
          return (
            computeAgentAcknowledgementTargets(records, subjectKey).length > 0 ||
            (arrived &&
              target.worktreeId !== null &&
              isWorkspaceFlagSet(
                s,
                target.worktreeId,
                target.worktreeId === s.activeWorktreeId ? s.activeWorkspaceExecutionHostId : null
              )) ||
            (options?.force &&
              reads.some((read) => read.subjectKey === subjectKey && read.structured))
          )
        })
      if (hasAttention) {
        pendingPresenceReads = reads
        presence.request()
        return
      }
    }

    // Why before the writes below: they re-enter this scan synchronously, which must not see an arrival again.
    lastReadScreenKey = screenKey
    pendingPresenceReads = undefined
    const activeSubjectKeys = new Set<string>()
    for (const target of targets) {
      const subjectKey = surfaceForAutoAckTarget(s, target).resolveViewedSubjectKey(target.tabId)
      if (subjectKey) {
        activeSubjectKeys.add(subjectKey)
      }
    }
    // Protection lapses when the user moves on to another subject or the agent takes a new
    // turn; a still-active subject with an unchanged turn keeps its explicit mark-unread.
    const lapsedProtections = computeLapsedManualUnreadProtections(
      {
        liveTurns: s.agentStatusByPaneKey,
        retainedTurns: s.retainedAgentsByPaneKey,
        manuallyUnreadTurnStartedAt: s.manuallyUnreadTurnsByPaneKey
      },
      activeSubjectKeys
    )
    if (lapsedProtections.length > 0) {
      s.clearManuallyUnreadTurns(lapsedProtections)
    }

    for (const target of targets) {
      // Why re-read: acking target[0] writes to the store, which re-enters this scan synchronously
      // and may already have handled target[1]; `s` is a pre-write snapshot that would re-ack it.
      acknowledgeViewedAutoAckTarget(store.getState(), target, {
        reads,
        readViewed: options?.force
      })
    }
    store.getState().readOnScreenAttention(targets, { settleFlags: arrived })
  }
  // Why: run once on mount to catch a restored session that already has agents on the visible tab.
  maybeAck({ force: true })
  // Subscribe to all store changes; the ref-equality guard above skips unrelated updates.
  const unsubscribe = store.subscribe(() => maybeAck())
  const stopViews = env.subscribeStructuredViews((view) => maybeAck({ force: true, view }))
  const stopPresenceSignals = env.subscribePresenceSignals(
    () => maybeAck({ force: true }),
    () => maybeAck({ force: true, presenceConfirmed: true })
  )
  // Why only while a presence check is parked: keystrokes are the hottest path in the app.
  const stopTerminalInput = env.subscribeTerminalInput(() => {
    if (pendingPresenceReads !== undefined) {
      pendingPresenceReads = undefined
      maybeAck({ force: true, presenceConfirmed: true })
    }
  })
  return () => {
    presence.dispose()
    unsubscribe()
    stopViews()
    stopPresenceSignals()
    stopTerminalInput()
  }
}
