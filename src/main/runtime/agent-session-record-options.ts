import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type {
  AgentSessionOptionsReplacement,
  AgentSessionRecord
} from '../../shared/agent-session-record'

export function replaceAgentSessionRecordOptions(
  record: AgentSessionRecord,
  replacement: AgentSessionOptionsReplacement
): AgentSessionRecord {
  const { lease } = record
  // At rest the host is the only writer: a pick is intent the next start replays.
  const atRest = lease.claimStatus === 'released' && lease.ownerProcess === null
  if (lease.runtimeFence !== replacement.fence || (lease.claimStatus !== 'live' && !atRest)) {
    throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'leaseMoved' })
  }
  return 'options' in replacement
    ? { ...record, options: { ...replacement.options }, updatedAt: replacement.now }
    : { ...record, permissionMode: replacement.permissionMode, updatedAt: replacement.now }
}

/** A model a turn ran, recorded as the chat's own only while it has none: never over a pick, even
 *  one made since, and no other option moves. */
export type AgentSessionRanModel = { sessionId: string; fence: number; model: string; now: number }

export function recordAgentSessionRanModel(
  record: AgentSessionRecord,
  { model, ...at }: AgentSessionRanModel
): AgentSessionRecord {
  return record.options?.model !== undefined
    ? record
    : replaceAgentSessionRecordOptions(record, { ...at, options: { ...record.options, model } })
}
