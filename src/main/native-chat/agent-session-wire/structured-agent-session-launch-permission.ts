import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'
import { continuingStructuredAgentSessionInput } from './structured-agent-session-handing-over'
// Launch and restart require support; display retains saved intent until support is known.

import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentChatPermissionModes,
  chatModelSupportsAutoMode,
  chatPermissionModeNeedsModelSupport,
  effectiveChatPermissionMode,
  savedChatPermissionMode,
  type AgentChatPermissionChoice
} from '../../../shared/agent-chat-permission-mode'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

/** Held support and preparation have separate owners; neither changes permission policy. */
export function structuredAgentSessionPermissionFromCatalog(
  deps: Pick<StructuredAgentSessionHostDeps, 'agents'>,
  record: Pick<AgentSessionRecord, 'sessionId' | 'provider' | 'options' | 'permissionMode'>,
  listing: AgentSessionModelCatalogResult | null | undefined
): AgentChatPermissionChoice | null {
  const support = agentChatPermissionModes(record.provider)
  if (!support || !deps.agents.definition(record.provider)) {
    return null
  }
  const autoSupported =
    listing !== null &&
    listing !== undefined &&
    listing.origin !== 'unknown' &&
    chatModelSupportsAutoMode(listing.models, record.options?.model)
  return effectiveChatPermissionMode(support, record.permissionMode, autoSupported)
}

export function structuredAgentSessionDisplayPermission(
  deps: Pick<StructuredAgentSessionHostDeps, 'agents'>,
  record: Pick<AgentSessionRecord, 'sessionId' | 'provider' | 'options' | 'permissionMode'>,
  listing: AgentSessionModelCatalogResult
): AgentChatPermissionChoice | null {
  const support = agentChatPermissionModes(record.provider)
  return listing.origin === 'unknown' && support && deps.agents.definition(record.provider)
    ? savedChatPermissionMode(support, record.permissionMode)
    : structuredAgentSessionPermissionFromCatalog(deps, record, listing)
}

/** null for unregistered agents or agents without permission modes. */
export async function structuredAgentSessionLaunchPermission(
  deps: Pick<StructuredAgentSessionHostDeps, 'agents' | 'modelCatalog'>,
  record: Pick<AgentSessionRecord, 'sessionId' | 'provider' | 'options' | 'permissionMode'>,
  deadline?: number
): Promise<AgentChatPermissionChoice | null> {
  const support = agentChatPermissionModes(record.provider)
  if (!support || !deps.agents.definition(record.provider)) {
    return null
  }
  const intent = record.permissionMode
  const params = {
    agent: record.provider,
    sessionId: record.sessionId,
    savedOnly: true,
    inSessionWorkspace: true as const,
    deadline
  }
  const listing = chatPermissionModeNeedsModelSupport(support, intent)
    ? await (deps.modelCatalog?.prepareSaved?.(params) ?? deps.modelCatalog?.read(params))?.catch(
        () => null
      )
    : null
  return structuredAgentSessionPermissionFromCatalog(deps, record, listing)
}

/** A synchronous admission read for providers whose modes need no model-catalog evidence. */
export function structuredAgentSessionImmediatePermission(
  deps: Pick<StructuredAgentSessionHostDeps, 'agents'>,
  record: AgentSessionRecord
): AgentChatPermissionChoice | null {
  const support = agentChatPermissionModes(record.provider)
  return support && deps.agents.definition(record.provider)
    ? savedChatPermissionMode(support, record.permissionMode)
    : null
}

/** Only the exact live, positively unwritten input pins its acquisition compiler to Auto. */
export function structuredAgentSessionInputCompilerPermission(
  journal: Parameters<typeof continuingStructuredAgentSessionInput>[0] | undefined,
  startedFor?: string
): 'auto' | undefined {
  return journal && startedFor && continuingStructuredAgentSessionInput(journal, startedFor)
    ? 'auto'
    : undefined
}

/** Read the live continuation at invocation, before ordinary asynchronous launch resolution. */
export function structuredAgentSessionAttachPermission(
  context: Pick<StructuredAgentSessionAttachContext, 'deps' | 'sessions'>,
  options: { startedFor?: string },
  lock: Pick<StructuredAgentSessionAttachLock, 'wait'>
): (record: AgentSessionRecord) => Promise<AgentChatPermissionChoice | undefined> {
  return async (record) =>
    structuredAgentSessionInputCompilerPermission(
      context.sessions.get(record.sessionId)?.journal,
      options.startedFor
    ) ??
    (await lock.wait(structuredAgentSessionLaunchPermission(context.deps, record))) ??
    undefined
}
