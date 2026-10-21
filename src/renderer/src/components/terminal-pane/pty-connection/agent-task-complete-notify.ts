import type { AgentIdleEdgeMeta } from '../../../../../shared/terminal-output-side-effects'
import { idleEdgeSettledAtRest, isClaudeIdleEdge } from '@/lib/agent-idle-edge'
import { useAppStore } from '@/store'

import { subscribeAgentTaskCompleteTrackingEnabled } from './agent-task-complete-settings'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

import { installAgentIdleWorkingHandlers } from './agent-idle-working-handlers'

export function installAgentTaskCompleteNotify(session: ConnectPanePtySession): void {
  session.agentTaskCompleteSettingsUnsubscribe = subscribeAgentTaskCompleteTrackingEnabled(() => {
    if (session.syncAgentTaskCompleteTrackingEnabled()) {
      session.agentCompletionCoordinator.startProcessTracking()
    }
  })

  // ─── Agent task-complete: notification-backed attention ───────────────
  //
  // The working→idle title transition drives two independent concerns:
  //   1. The Claude prompt-cache countdown in the sidebar.
  //   2. The "Agent Task Complete" OS notification users toggle in Settings.
  //
  // This path raises the same terminal attention marker as BEL through the
  // shared notification dispatcher. Not every agent CLI reliably emits BEL on
  // completion (Gemini, some Codex flows), and the highlight needs to remain
  // findable after the OS banner is gone. Double-firing with a concurrent BEL
  // is handled by delaying the BEL OS notification below; main still keeps a
  // 5 s per-worktree dedupe as the final guard.
  session.onAgentBecameIdle = (title: string, meta?: AgentIdleEdgeMeta): void => {
    // Why: a stale-derived idle comes from main's UNTHROTTLED 3s timer, not
    // observed bytes — a merely-paused agent (>3s silent mid-task, window
    // minimized) would otherwise mint a false task-complete OS notification
    // that renderer timer throttling previously damped. Clear session-tied
    // state only; never schedule completion attention from it.
    if (meta?.staleWorkingTitleClear) {
      session.deps.setCacheTimerStartedAt(session.cacheKey, null)
      return
    }
    const currentState = useAppStore.getState()
    const activeHookStatus = currentState.agentStatusByPaneKey[session.cacheKey]
    if (session.shouldSuppressTitleCompletionForFreshHook(title, activeHookStatus)) {
      // Why: agent CLIs can briefly publish an idle title while hook status
      // still says the same agent turn is active (e.g. during tool output).
      if (activeHookStatus) {
        session.preserveSuppressedTitleSideEffects(title, activeHookStatus)
      }
      return
    }
    // Why: only start the prompt-cache countdown for Claude agents — other
    // agents have different (or no) prompt-caching semantics and showing a
    // timer for them would be misleading.
    //
    // Why we check `settings !== null` separately: during startup, settings
    // hydrate asynchronously after terminals reconnect. If we treat null
    // as disabled, the first working→idle transition on a restored Claude
    // tab silently drops the timer. Writing a timestamp is cheap and the
    // CacheTimer component gates rendering on the enabled flag, so a
    // spurious write when the feature turns out to be disabled is harmless.
    const settings = currentState.settings
    if (
      isClaudeIdleEdge(title, activeHookStatus) &&
      (settings === null || settings.promptCacheTimerEnabled)
    ) {
      session.deps.setCacheTimerStartedAt(session.cacheKey, Date.now())
    }
    if (idleEdgeSettledAtRest(title, meta)) {
      session.setFocusReportSuppressionForAgentCompletion(title, activeHookStatus?.agentType)
    }
    if (session.syncAgentTaskCompleteTrackingEnabled()) {
      session.agentCompletionCoordinator.observeClassifiedTitleCompletion(title)
    }
    // Why: some agent TUIs leave xterm renderer modes active after a turn.
    // Reset cursor everywhere, and Kitty keyboard state on native Windows.
    session.queueAgentIdleTerminalModeReset()
  }
  installAgentIdleWorkingHandlers(session)
}
