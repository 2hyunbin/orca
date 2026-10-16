import { STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS } from '@/components/native-chat/structured-agent-session-message-sender'
import { recoverPublishedSessionReceipt } from './structured-agent-session-launch-recovery'
import { publishStructuredLaunchCreateOptions } from './structured-agent-session-launch-create-message'
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
  void Promise.race([recoverPublishedSessionReceipt(state, false), expired]).then(async (receipt) => {
    if (state.cancelled || getStructuredLaunchStateBySessionId(sessionId) !== state) {
      return
    }
    await publishStructuredLaunchCreateOptions(state, receipt)
    state.hostPublished = true
    notifyStructuredLaunchListeners()
    // The original command still owns refusal; a restored observation has an already settled promise.
    void state.promise.then(() => {
      if (!state.cancelled && getStructuredLaunchStateBySessionId(sessionId) === state) {
        settleStructuredLaunchCallers(state.callers, 'published')
        notifyStructuredLaunchListeners()
      }
    }, () => {})
  }).catch(() => {
    // An absent or unreadable journal says nothing new about the command's outcome.
  }).finally(() => {
    clearTimeout(deadline)
    confirming.delete(state)
  })
}
