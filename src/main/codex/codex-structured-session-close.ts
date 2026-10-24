import {
  finishChildWorkAdmission,
  type ChildWorkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-accepted-child-work'
import { agentSessionFailureFact, providerDiagnosticOf } from '../../shared/agent-session-failure'
import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import { closeProcessRegistry } from '@orca/process-host/close-process-registry'
import {
  cancelCodexAcquisitionAttempt,
  type CodexAcquisitionRegistry,
  type CodexSession,
  type CodexStructuredSessionEvent
} from './codex-structured-session-state'
import type { StructuredAgentSessionEndedEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

export function handleCodexSessionExit(input: {
  sessions: Map<string, CodexSession>
  sessionId: string
  connection: CodexAppServerConnection | null
  error: Error
  /** Set for the end of a close Orca began: by that close, or by the root's own exit report. */
  closedByOrca?: true
  prompts?: CodexSession['prompts']
  onEvent?: (event: CodexStructuredSessionEvent) => void
  logger?: StructuredAgentSessionLogger
}): boolean {
  const session = input.sessions.get(input.sessionId)
  if (!session || session.connection !== input.connection || session.ended) {
    input.prompts?.clear()
    return false
  }
  session.exitObservedAt ??= Date.now()
  session.events?.observeExit?.(session.dispatchEchoes.heldSends(), session.exitObservedAt)
  // Before the admission check: the child is gone whether or not its end was admitted.
  session.turnOpenWaits.releaseAll()
  const event: StructuredAgentSessionEndedEvent = {
    type: 'ended',
    sessionId: input.sessionId,
    // The connection reports the exit inside the close it ends; the close's own reason is the why.
    reason: ((input.closedByOrca && session.orcaClose?.reason) || input.error).message,
    // Only the child's own exit blames Codex; a close Orca made, for any reason, is Orca's.
    failure: input.closedByOrca
      ? agentSessionFailureFact('hostFault')
      : agentSessionFailureFact('providerExited', { detail: providerDiagnosticOf(input.error) }),
    cause: session.orcaClose?.requested ? 'requested-close' : 'unexpected-exit',
    fence: session.fence,
    acquisitionGeneration: session.acquisitionGeneration,
    observedAt: session.exitObservedAt
  } as const
  // A synchronous sink rejection (usually backpressure) leaves the terminal rows to the host's
  // exit settlement, which writes its own bounded fallback. The exit itself is observed, so the
  // session ends either way: holding a dead child as unproven over a refused row would strand it.
  const producer = session.workProducer ?? session.events
  let translate = () => session.translator?.handle(event) ?? { accepted: true as const }
  let suffix: (() => ChildWorkAdmission) | undefined
  const append = (): ChildWorkAdmission => {
    if (suffix) {
      return suffix()
    }
    const admission = translate()
    if (!admission.accepted) {
      const retry = admission.retry
      translate = retry ?? (() => admission)
      return {
        accepted: false,
        reason: admission.reason === 'untranslated' ? 'failed' : admission.reason,
        retry: append
      }
    }
    session.backgroundTasks.clear()
    suffix = () => session.backgroundTasks.publishChildWork() ?? { accepted: true }
    const result = suffix()
    if (!result.accepted && result.retry) {
      suffix = result.retry
    }
    return result
  }
  const admission = producer?.continueWork?.(append) ?? append()
  session.ended = true
  session.dispatchEchoes.clear()
  session.prompts.clear()
  session.endWritten = finishChildWorkAdmission(admission, producer).then((result) => {
    if (!result.ok) {
      input.logger?.warn('Codex final work ended unwritten', {
        scope: 'codex-child-work',
        sessionId: input.sessionId,
        error: result.error
      })
    }
    session.unbindReadingControl?.()
    session.translator?.dispose()
    try {
      input.onEvent?.(event)
    } catch (error) {
      input.logger?.warn('Codex exit observer failed', { scope: 'codex-exit', error })
    }
    return result
  })
  return true
}

export async function closeCodexPublishedSession(
  sessions: Map<string, CodexSession>,
  sessionId: string,
  onEvent?: (event: CodexStructuredSessionEvent) => void,
  options?: {
    logger?: StructuredAgentSessionLogger
    requestedClose?: boolean
    expectedFence?: number
    expectedAcquisitionGeneration?: string
    unexpectedReason?: Error
  }
): Promise<boolean> {
  const session = sessions.get(sessionId)
  if (!session) {
    return true
  }
  if (
    (options?.expectedFence !== undefined && session.fence !== options.expectedFence) ||
    (options?.expectedAcquisitionGeneration !== undefined &&
      session.acquisitionGeneration !== options.expectedAcquisitionGeneration)
  ) {
    return false
  }
  if (session.ended && session.connection.closed) {
    await session.endWritten
    sessions.delete(sessionId)
    return true
  }
  // Sink-failure recovery force-closes the child but must preserve the
  // observed-exit cause so host lease settlement runs as an unexpected death.
  session.orcaClose ??= {
    requested: options?.requestedClose ?? true,
    reason: options?.unexpectedReason ?? new Error('codex session closed')
  }
  // Keep the session indexed until the child exit is observed. A timeout or
  // failed kill must leave the live connection available for a safe retry.
  const exited = await session.connection.close()
  if (exited !== true) {
    return false
  }
  if (!session.ended) {
    handleCodexSessionExit({
      sessions,
      sessionId,
      connection: session.connection,
      error: session.orcaClose.reason,
      closedByOrca: true,
      prompts: session.prompts,
      ...(onEvent ? { onEvent } : {}),
      ...(options?.logger ? { logger: options.logger } : {})
    })
  }
  await session.endWritten
  sessions.delete(sessionId)
  return true
}

export async function closeCodexSession(
  sessionId: string,
  sessions: Map<string, CodexSession>,
  acquisitions: CodexAcquisitionRegistry,
  onEvent?: (event: CodexStructuredSessionEvent) => void,
  logger?: StructuredAgentSessionLogger,
  requestedClose = true
): Promise<boolean> {
  const attempt = acquisitions.get(sessionId)
  const published = sessions.get(sessionId)
  if (attempt && published?.connection === attempt.window.connection) {
    attempt.cancelled = true
    attempt.requestedClose = requestedClose
    const closed = await closeCodexPublishedSession(sessions, sessionId, onEvent, {
      requestedClose,
      ...(logger ? { logger } : {})
    })
    if (closed) {
      acquisitions.deleteIfCurrent(sessionId, attempt)
    }
    return closed
  }
  if (!(await cancelCodexAcquisitionAttempt(attempt, requestedClose))) {
    return false
  }
  if (attempt) {
    acquisitions.deleteIfCurrent(sessionId, attempt)
  }
  return closeCodexPublishedSession(sessions, sessionId, onEvent, {
    requestedClose,
    ...(logger ? { logger } : {})
  })
}

export async function closeAllCodexSessions(
  sessions: Map<string, CodexSession>,
  acquisitions: CodexAcquisitionRegistry,
  close: (sessionId: string) => Promise<boolean>
): Promise<void> {
  acquisitions.close()
  await closeProcessRegistry({
    attempts: 3,
    hasEntries: () => sessions.size > 0 || acquisitions.size > 0,
    entryIds: () => new Set([...sessions.keys(), ...acquisitions.sessionIds()]),
    closeEntry: close,
    failureMessage: 'codex structured session shutdown could not prove every child stopped'
  })
}
