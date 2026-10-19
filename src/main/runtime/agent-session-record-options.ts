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

/** The options a turn ran, each recorded only where the chat has none saved, so a pick, even one
 *  made since, always wins. */
export type AgentSessionRanOptions = {
  sessionId: string
  fence: number
  options: Readonly<Record<string, string>>
  now: number
}

export function recordAgentSessionRanOptions(
  record: AgentSessionRecord,
  { options, ...at }: AgentSessionRanOptions
): AgentSessionRecord {
  return Object.keys(options).every((key) => record.options?.[key] !== undefined)
    ? record
    : replaceAgentSessionRecordOptions(record, {
        ...at,
        options: { ...options, ...record.options }
      })
}
