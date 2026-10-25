import type {
  AgentSessionCancelOutcome,
  AgentSessionStopOutcome
} from '../native-chat/agent-session-wire/structured-agent-session-adapter-stop'
import { isCodexAppServerRequestError } from './app-server/codex-app-server-request-error'
import { readRecord } from './codex-item-field-readers'
import { codexMethodUnavailable } from './codex-structured-applied-settings'
import type { CodexSession } from './codex-structured-session-state'
import { CODEX_STOP_GRACE_MS } from './codex-request-end-wait'

/** RPC ordering excludes earlier goal handlers, but cannot certify model-tool write quiescence. */
export async function stopCodexGoal(input: {
  session: CodexSession
  stoppedAt: number
  timeoutMs?: number
  current: () => boolean
  interrupt: () => Promise<AgentSessionCancelOutcome>
}): Promise<AgentSessionCancelOutcome> {
  const { session, current } = input
  const deadline = input.stoppedAt + CODEX_STOP_GRACE_MS
  const facts: AgentSessionStopOutcome = {
    pause: 'unconfirmed',
    interrupt: 'not-needed',
    root: 'unproven',
    workload: 'unproven',
    errors: []
  }
  let unavailable = false
  const pause = async (phaseDeadline: number) => {
    const rpc = (method: string, params: Record<string, unknown>) => {
      if (!current() || session.connection.closed || phaseDeadline <= Date.now()) {
        throw new Error('codex Stop reconciliation unavailable')
      }
      return session.connection.request(method, params, {
        timeoutMs: Math.min(input.timeoutMs ?? 30_000, phaseDeadline - Date.now())
      })
    }
    try {
      const result = readRecord(await rpc('thread/goal/get', { threadId: session.threadId }))
      if (!Object.hasOwn(result, 'goal')) {
        throw new Error('codex goal read did not report a goal')
      }
      facts.lastGoalState = result.goal
      if (readRecord(result.goal).status === 'active') {
        const paused = readRecord(
          await rpc('thread/goal/set', {
            threadId: session.threadId,
            status: 'paused',
            origin: 'user'
          })
        )
        facts.lastGoalState = paused.goal
      }
    } catch (error) {
      if (
        codexMethodUnavailable(error, 'thread/goal/get') ||
        (isCodexAppServerRequestError(error) &&
          /(?:^|: )goals feature is disabled[.!]?$/i.test(error.message))
      ) {
        unavailable = true
        facts.pause = 'not-needed'
      } else {
        facts.errors.push(error)
      }
    }
  }
  await pause(Math.min(deadline, Date.now() + Math.max(0, deadline - Date.now()) / 3))
  let outcome: AgentSessionCancelOutcome = { cancelled: false }
  try {
    if (!current()) {
      throw new Error('codex Stop acquisition ended')
    }
    outcome = await input.interrupt()
    facts.interrupt = outcome.cancelled
      ? 'accepted'
      : outcome.refusal
        ? 'unconfirmed'
        : 'not-needed'
    if (outcome.refusal) {
      facts.errors.push(outcome.refusal)
    }
  } catch (error) {
    facts.interrupt = 'unconfirmed'
    facts.errors.push(error)
  }
  if (!unavailable) {
    await pause(deadline)
  }
  return { ...outcome, stop: facts }
}
