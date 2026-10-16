import { ensureRuntimeEnvironmentCompatible } from '@/runtime/runtime-rpc-client'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { isDefinitiveAgentSessionCreateRefusal } from '../../../shared/agent-session-definitive-refusal'
import { readAgentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'
import { readAgentSessionErrorRefusal } from '../../../shared/agent-session-write-failure'
import {
  callStructuredAgentSession,
  supportsStructuredAgentSessionCreateMessage
} from '@/runtime/structured-agent-session-client'
import { publishStructuredAgentSessionCreateHydration } from './structured-agent-session-create-hydration'
import { askHostCreateSupport } from './structured-agent-session-host-admission'
import {
  abandonStructuredAgentSessionLaunchIntent,
  type StructuredAgentSessionLaunchIntent
} from './launch-structured-agent-session'
import type { StructuredAgentLaunchReceipt } from './structured-agent-session-launch-recovery'
import {
  StructuredAgentSessionCreateError,
  StructuredAgentSessionSubmissionEndedError,
  StructuredAgentSessionCreateRefusalError,
  StructuredAgentSessionCreateUnknownOutcomeError
} from './structured-agent-session-launch-errors'

type LaunchSeed = Readonly<Record<string, string>> | undefined
const DEFINITIVE_CREATE_FAILURE_CODES = [
  'structured_agent_session_unsupported',
  'method_not_found'
] as const

function definitiveStructuredAgentSessionCreateErrorCode(error: unknown): string | null {
  if (error instanceof StructuredAgentSessionCreateError) {
    // Our own classes already carry the verdict; message sniffing below could only invert it.
    return error instanceof StructuredAgentSessionCreateRefusalError &&
      isDefinitiveAgentSessionCreateRefusal(error.code)
      ? error.code
      : null
  }
  for (const code of DEFINITIVE_CREATE_FAILURE_CODES) {
    if (hasRuntimeRpcErrorCode(error, code)) {
      return code
    }
  }
  return null
}

/**
 * Only the host that will execute the session can answer whether it supports creating one there.
 * Both providers ask: the host classifies per agent, and Codex inherits the
 * unresolvable-selector retry above along with the probe. The unknown branch stays on the chat for
 * reconciliation: a retry may follow a create whose reply was lost. Answers the seed create will use.
 */
async function requireHostCreateSupport(
  intent: StructuredAgentSessionLaunchIntent
): Promise<LaunchSeed> {
  const support = await askHostCreateSupport(intent.target, intent.params.worktree, intent.agent)
  if (support.kind === 'unreachable') {
    throw new StructuredAgentSessionCreateUnknownOutcomeError(
      support.message,
      support.code,
      readAgentSessionErrorRefusal(support.error)
    )
  }
  if (support.kind === 'declined' || support.kind === 'workspace-unresolved') {
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateRefusalError(
      'structured_agent_session_unsupported',
      'structured_agent_session_unsupported'
    )
  }
  return support.seedOptions
}

/** Told the seed a paired server says this create will use, which may differ from an earlier
 *  attempt's; a local launch reads its own settings instead. */
export type StructuredLaunchHostSeedListener = (seedOptions: LaunchSeed) => void

export async function launchStructuredAgentSession(
  intent: StructuredAgentSessionLaunchIntent,
  onHostSeed?: StructuredLaunchHostSeedListener,
  priorCreateOutcomeUnknown = false,
  reservedSubmission = false
): Promise<StructuredAgentLaunchReceipt> {
  let hostSeed: LaunchSeed
  try {
    hostSeed = await requireHostCreateSupport(intent)
  } catch (error) {
    if (!reservedSubmission || error instanceof StructuredAgentSessionCreateRefusalError) {
      throw error
    }
    throw new StructuredAgentSessionCreateRefusalError(
      error instanceof Error ? error.message : 'The chat host is unavailable.',
      'structured_agent_session_unsupported'
    )
  }
  if (intent.target.kind !== 'local') {
    onHostSeed?.(hostSeed)
  }
  let issue: void | (() => void) = undefined
  if (!intent.createPrepared) {
    let supported = false
    try {
      supported = await supportsStructuredAgentSessionCreateMessage(intent.target)
    } catch {
      // Unknown capability stays on the compatible create path.
    }
    if (!intent.createPrepared) {
      intent.createMessageSupport = supported
      try {
        issue = await intent.prepareCreate?.()
      } catch (error) {
        // Preparation failed before create was issued, so its sources remain safe to submit again.
        if (error instanceof StructuredAgentSessionSubmissionEndedError) {
          throw error
        }
        throw new StructuredAgentSessionCreateRefusalError(
          error instanceof Error ? error.message : 'The message could not be prepared.',
          'agent_session_attachment_unavailable'
        )
      }
    }
  }
  if (reservedSubmission && intent.target.kind === 'environment') {
    try {
      await ensureRuntimeEnvironmentCompatible(intent.target.environmentId)
    } catch (error) {
      throw new StructuredAgentSessionCreateRefusalError(
        error instanceof Error ? error.message : 'The chat host is unavailable.',
        'structured_agent_session_unsupported'
      )
    }
  }
  let result: AgentSessionMutationResult<AgentSessionAttachResult>
  try {
    issue?.()
    intent.createPrepared = true
    result = reservedSubmission && intent.target.kind === 'environment'
      ? await callStructuredAgentSession<AgentSessionMutationResult<AgentSessionAttachResult>>(
          intent.target, 'agentSession.create', intent.params, { skipCompatibilityCheck: true }
        )
      : await callStructuredAgentSession<AgentSessionMutationResult<AgentSessionAttachResult>>(
          intent.target, 'agentSession.create', intent.params
        )
  } catch (error) {
    const code = definitiveStructuredAgentSessionCreateErrorCode(error)
    if (code) {
      abandonStructuredAgentSessionLaunchIntent(intent)
      throw new StructuredAgentSessionCreateRefusalError(
        error instanceof Error ? error.message : String(error),
        code,
        readAgentSessionErrorRefusal(error)
      )
    }
    throw error
  }
  if (!result.ok) {
    const { code, message, ownerVerdict } = result.refusal
    const refusal = readAgentSessionRefusalReference(result.refusal)
    const transcriptRefusedBeforeCommit =
      !priorCreateOutcomeUnknown &&
      result.refusal.createAttemptRefusedBeforeCommit === true &&
      refusal?.code === 'agent_session_identity_required' &&
      (refusal.details?.reason === 'transcriptNotFound' ||
        refusal.details?.reason === 'transcriptUnreadable')
    // A proven precommit transcript refusal lets a new operation retry.
    if (
      !transcriptRefusedBeforeCommit &&
      !isDefinitiveAgentSessionCreateRefusal(code) &&
      ownerVerdict !== 'exited'
    ) {
      // Keep the focus intent: the session may exist, and recovery still has to adopt it.
      throw new StructuredAgentSessionCreateUnknownOutcomeError(message, code, refusal)
    }
    abandonStructuredAgentSessionLaunchIntent(intent)
    throw new StructuredAgentSessionCreateRefusalError(message, code, refusal)
  }
  const firstMessage = intent.params.firstMessage
    ? (result.value.firstMessage ??
      result.value.page.submissions.find(
        (submission) => submission.clientMessageId === intent.params.firstMessage?.clientMessageId
      ))
    : undefined
  if (
    intent.params.firstMessage &&
    firstMessage?.clientMessageId !== intent.params.firstMessage.clientMessageId
  ) {
    throw new StructuredAgentSessionCreateUnknownOutcomeError(
      'The created chat did not confirm its first message.',
      'agent_session_operation_unknown'
    )
  }
  if (intent.createMessageSupport === true) {
    publishStructuredAgentSessionCreateHydration(intent, result.value.page, result.value.fence)
  }
  return {
    sessionId: result.value.sessionId,
    fence: result.value.fence,
    ...(firstMessage ? { firstMessage, cursor: result.cursor } : {})
  }
}
