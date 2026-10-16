import { STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS } from '@/components/native-chat/structured-agent-session-message-sender'
import { recoverPublishedSessionReceipt } from './structured-agent-session-launch-recovery'
import { finalizeStructuredLaunchFirstSubmission } from './structured-agent-session-launch-outcome-tracking'
import { settleStructuredLaunchCallers } from './structured-agent-session-launch-callers'
import { restorePersistedStructuredLaunchState } from './structured-agent-session-launch-reload'
import {
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchListeners,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'

const confirming = new WeakSet<StructuredLaunchState>()

/** Confirmation observes positive evidence; it never replaces the execution promise or verdict. */
export function confirmStructuredLaunchFirstMessagePublication(worktreeId: string, sessionId: string): void {
  const state = getStructuredLaunchStateBySessionId(sessionId) ??
    restorePersistedStructuredLaunchState(worktreeId, sessionId)
  if (!state || state.cancelled || state.callers.outcome === 'failed' || confirming.has(state)) {
    return
  }
  confirming.add(state)
  let deadline: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error('Confirmation timed out.')), STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS)
  })
  void Promise.race([recoverPublishedSessionReceipt(state), expired]).then(async () => {
    if (state.cancelled || getStructuredLaunchStateBySessionId(sessionId) !== state) {
      return
    }
    if (state.intent.firstSubmission) {
      await finalizeStructuredLaunchFirstSubmission(state)
    } else {
      settleStructuredLaunchCallers(state.callers, 'published')
      notifyStructuredLaunchListeners()
    }
  }).catch(() => {
    // An absent or unreadable journal says nothing new about the command's outcome.
  }).finally(() => {
    clearTimeout(deadline)
    confirming.delete(state)
  })
}
