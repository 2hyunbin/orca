// The one place that decides a chat's permission mode: what a start launches, a restart compares, a read shows.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentChatPermissionModes,
  chatModelListedWithoutAutoMode,
  chatPermissionModeNeedsModelSupport,
  effectiveChatPermissionMode,
  type AgentChatPermissionMode
} from '../../../shared/agent-chat-permission-mode'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'

/** Saved catalog only, so a start never waits on a listing; for the chat's own folder, as its
 *  options read names its default. A missing catalog keeps the saved choice: Claude itself starts
 *  a model that can't run `auto` in its default mode. */
async function listedWithoutAutoMode(
  catalog: StructuredAgentSessionHostDeps['modelCatalog'],
  record: AgentSessionRecord
): Promise<boolean> {
  const listing = await catalog
    ?.read({
      agent: record.provider,
      sessionId: record.sessionId,
      savedOnly: true,
      inSessionWorkspace: true
    })
    .catch(() => null)
  return (
    listing !== null &&
    listing !== undefined &&
    listing.origin !== 'unknown' &&
    chatModelListedWithoutAutoMode(listing.models, record.options?.model)
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
  const listedWithoutAuto =
    chatPermissionModeNeedsModelSupport(support, intent) &&
    (await listedWithoutAutoMode(deps.modelCatalog, record))
  return effectiveChatPermissionMode(support, intent, listedWithoutAuto)
}
