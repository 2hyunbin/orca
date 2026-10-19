// The execution host's own delivery of terminal agents' hook news ("finished", "needs input") to the
// phones paired with it.
//
// WHY THE HOST: the agent's hooks report here, so a phone paired to this host (a headless server, or
// a desktop whose window never shows the tab because a paired desktop started it in the background)
// must not depend on some window holding the tab. A local window marks its own hook-lane request so
// main does not push it twice; a paired desktop skips phones that say they hear from this host.
//
// THE WINDOW'S HOOK-LANE RULES, PORTED: a forwarding desktop drops its copy for phones this host
// reaches, so this must announce at least what a window's hook lane announces. That is more than the
// transition detector's news: a turn that finished while Claude keeps background work (`working` with
// a new `turnCompletedAt`), a `done` with no `working` seen, and a turn the user stopped.
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import { agentMainAgentVerdict } from '../../shared/agent-main-agent-verdict'
import { buildAgentNotificationId } from '../../shared/agent-notification-id'
import type { AgentStatusIpcPayload, AgentStatusState } from '../../shared/agent-status-types'
import type {
  NotificationDispatchRequest,
  NotificationSettings
} from '../../shared/notification-settings-types'
import { isPiCompatibleAgentType } from '../../shared/pi-agent-kind'
import { buildNotificationOptions } from '../ipc/notification-options'
import type { MobileNotificationDispatchEvent } from './runtime-mobile-notification-controller'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'
import type { StructuredAttentionWorkspaceLabels } from './structured-agent-session-mobile-attention'

/** The window holds a `done` this long (`HOOK_DONE_QUIET_MS`) so a turn that resumes at once is not announced. */
export const HOST_HOOK_DONE_QUIET_MS = 1_500

export type TerminalAgentMobileAttentionDeps = {
  readRow: (paneKey: string) => AgentStatusIpcPayload | null
  readNotificationSettings: () => NotificationSettings | undefined
  readWorkspaceLabels: (workspaceId: string) => StructuredAttentionWorkspaceLabels
  isWorkspaceMuted: (workspaceId: string) => boolean
  dispatch: (event: MobileNotificationDispatchEvent) => void
  now: () => number
  schedule?: (run: () => void, delayMs: number) => () => void
}

type PaneMemory = {
  lastId: string | null
  sawWorking: boolean
  lastTurnCompletedAt: number | null
  heldId: string | null
  cancelHold: (() => void) | null
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function createTerminalAgentMobileAttention(
  deps: TerminalAgentMobileAttentionDeps
): (change: AgentPaneChange) => void {
  const panes = new Map<string, PaneMemory>()
  const schedule =
    deps.schedule ??
    ((run, delayMs) => {
      const timer = setTimeout(run, delayMs)
      timer.unref?.()
      return () => clearTimeout(timer)
    })

  const memoryFor = (paneKey: string): PaneMemory => {
    let memory = panes.get(paneKey)
    if (!memory) {
      memory = {
        lastId: null,
        sawWorking: false,
        lastTurnCompletedAt: null,
        heldId: null,
        cancelHold: null
      }
      panes.set(paneKey, memory)
    }
    return memory
  }

  const cancelHold = (memory: PaneMemory): void => {
    memory.cancelHold?.()
    memory.cancelHold = null
    memory.heldId = null
  }

  const announce = (
    worktreeId: string,
    row: AgentStatusIpcPayload,
    agentState: AgentStatusState,
    notificationId: string
  ): void => {
    if (deps.isWorkspaceMuted(worktreeId)) {
      return
    }
    const settings = deps.readNotificationSettings()
    if (!settings) {
      return
    }
    let labels: StructuredAttentionWorkspaceLabels = {}
    try {
      labels = deps.readWorkspaceLabels(worktreeId)
    } catch {
      // A label is presentation: without one the alert still goes out, worded generically.
    }
    const outcome = agentState === 'done' ? agentMainAgentVerdict(row) : null
    const request: NotificationDispatchRequest = {
      source: 'agent-task-complete',
      worktreeId,
      ...labels,
      agentState,
      ...(row.agentType ? { agentType: row.agentType } : {}),
      ...(row.prompt ? { agentPrompt: row.prompt } : {}),
      ...(row.toolName ? { agentToolName: row.toolName } : {}),
      ...(row.toolInput ? { agentToolInput: row.toolInput } : {}),
      ...(row.lastAssistantMessage ? { agentLastAssistantMessage: row.lastAssistantMessage } : {}),
      ...(outcome ? { agentTurnOutcome: outcome } : {})
    }
    const { title, body } = buildNotificationOptions(
      request,
      getRuntimeDesktopSurface().translateNotification
    )
    // The same eligibility the desktop's own fan-out applies: these preferences gate the phone too.
    const desktopAllowed = settings.enabled && settings.agentTaskComplete
    deps.dispatch({
      type: 'notification',
      emittedAt: deps.now(),
      source: 'agent-task-complete',
      ...(!desktopAllowed ? { desktopAllowed: false } : {}),
      title,
      body,
      worktreeId,
      notificationId,
      agentState,
      hostAgentAlert: true
    })
  }

  return (change) => {
    // Every look arrives as `seeded` or `observed`; `moved` repeats one of them.
    if (change.kind === 'moved') {
      return
    }
    const { paneKey } = change
    const row = deps.readRow(paneKey)
    const memory = panes.get(paneKey)
    if (!row || !change.workspace) {
      if (memory) {
        cancelHold(memory)
        panes.delete(paneKey)
      }
      return
    }
    // Native chat rows are announced by their own host producer.
    if (row.structuredHost || row.programStatusOnly || row.providerSessionOnly) {
      return
    }
    // The id the window builds: the hook's own workspace first, as its status applicator reads it.
    const worktreeId = row.worktreeId ?? change.workspace.worktreeId
    const pane = memoryFor(paneKey)
    const turnCompletedAt = finiteOrNull(row.turnCompletedAt)
    const id = (stateStartedAt: number): string | null =>
      buildAgentNotificationId({ worktreeId, paneKey, stateStartedAt })

    // A relay replay of a turn this host never saw end is news, as the window's replay rule has it.
    const unseenReplay =
      row.isReplay === true &&
      memory !== undefined &&
      ((row.state === 'working' && turnCompletedAt !== null) ||
        (row.state === 'done' && id(row.stateStartedAt) !== pane.lastId))
    if (change.kind === 'seeded' && !unseenReplay) {
      // Restored or replayed: never news, only what later rows compare against.
      pane.lastId = id(row.stateStartedAt)
      pane.lastTurnCompletedAt = turnCompletedAt
      pane.sawWorking = row.state === 'working'
      return
    }

    if (row.state === 'working') {
      cancelHold(pane)
      const sawWorking = pane.sawWorking
      pane.sawWorking = true
      if (turnCompletedAt === null || turnCompletedAt === pane.lastTurnCompletedAt) {
        return
      }
      pane.lastTurnCompletedAt = turnCompletedAt
      const turnId = id(turnCompletedAt)
      if (sawWorking && turnId && turnId !== pane.lastId) {
        pane.lastId = turnId
        announce(worktreeId, row, 'done', turnId)
      }
      return
    }

    if (row.state === 'blocked' || row.state === 'waiting') {
      cancelHold(pane)
      const attentionId = id(row.stateStartedAt)
      if (attentionId && attentionId !== pane.lastId) {
        pane.lastId = attentionId
        announce(worktreeId, row, row.state, attentionId)
      }
      return
    }

    // `done`: a session boundary is not a turn, and a turn already announced by its stamp is old news.
    const doneId = id(row.stateStartedAt)
    if (
      row.sessionBoundary ||
      !doneId ||
      doneId === pane.lastId ||
      doneId === pane.heldId ||
      (turnCompletedAt !== null && turnCompletedAt === pane.lastTurnCompletedAt)
    ) {
      return
    }
    cancelHold(pane)
    if (turnCompletedAt !== null) {
      pane.lastTurnCompletedAt = turnCompletedAt
    }
    // Pi emits milestone `done`s mid-turn, and a turn can resume at once; the window holds those.
    if (!pane.sawWorking && !isPiCompatibleAgentType(row.agentType?.trim().toLowerCase())) {
      pane.lastId = doneId
      announce(worktreeId, row, 'done', doneId)
      return
    }
    pane.heldId = doneId
    pane.cancelHold = schedule(() => {
      pane.cancelHold = null
      pane.heldId = null
      const current = deps.readRow(paneKey)
      if (
        panes.get(paneKey) !== pane ||
        current?.state !== 'done' ||
        current.stateStartedAt !== row.stateStartedAt
      ) {
        return
      }
      pane.lastId = doneId
      announce(worktreeId, current, 'done', doneId)
    }, HOST_HOOK_DONE_QUIET_MS)
  }
}
