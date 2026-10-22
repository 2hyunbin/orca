// The one place that decides a chat's permission mode: what a start launches, a restart compares, a read shows.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentChatPermissionModes,
  chatModelSupportsAutoMode,
  chatPermissionModeNeedsModelSupport,
  effectiveChatPermissionMode,
  type AgentChatPermissionMode
} from '../../../shared/agent-chat-permission-mode'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

/** Saved catalog only, so a start never waits on a listing; for the chat's own folder, as its
 *  options read names its default. */
async function listedAutoModeSupport(
  catalog: StructuredAgentSessionHostDeps['modelCatalog'],
  record: AgentSessionRecord
): Promise<boolean> {
  const params = {
    agent: record.provider,
    sessionId: record.sessionId,
    savedOnly: true,
    inSessionWorkspace: true as const
  }
  const listing = await (catalog?.prepareSaved?.(params) ?? catalog?.read(params))?.catch(
    () => null
  )
  return (
    listing !== null &&
    listing !== undefined &&
    listing.origin !== 'unknown' &&
    chatModelSupportsAutoMode(listing.models, record.options?.model)
  )
}

/** Null for an agent whose chats offer no modes, or one this runtime did not register. */
export async function structuredAgentSessionLaunchPermission(
  deps: Pick<StructuredAgentSessionHostDeps, 'agents' | 'modelCatalog'>,
  record: AgentSessionRecord
): Promise<AgentChatPermissionMode | null> {
  const support = agentChatPermissionModes(record.provider)
  if (!support || !deps.agents.definition(record.provider)) {
    return null
  }
  const intent = record.permissionMode
  const autoSupported =
    chatPermissionModeNeedsModelSupport(support, intent) &&
    (await listedAutoModeSupport(deps.modelCatalog, record))
  return effectiveChatPermissionMode(support, intent, autoSupported)
}
