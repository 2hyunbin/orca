import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { TerminalSwitchWrite } from '../../shared/terminal-switch'

/** Unfenced like the name: the descriptor is the switch owner's obligation, not the writer lease.
 *  A clear names its generation, so an old completion never clears a newer switch. */
export function setAgentSessionRecordTerminalSwitch(
  record: AgentSessionRecord,
  descriptor: TerminalSwitchWrite,
  now: number
): AgentSessionRecord {
  if ('clear' in descriptor) {
    if (record.terminalSwitch?.generation !== descriptor.clear) {
      return record
    }
    const next = { ...record, updatedAt: now }
    delete next.terminalSwitch
    return next
  }
  return { ...record, terminalSwitch: descriptor, updatedAt: now }
}
