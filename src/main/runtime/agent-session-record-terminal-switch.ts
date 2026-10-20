import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { TerminalSwitchWrite } from '../../shared/terminal-switch'

/** Unfenced like the name: the descriptor is the switch owner's obligation, not the writer lease.
 *  Compare-and-set on generation, so a stale collector never resurrects or replaces another. */
export function setAgentSessionRecordTerminalSwitch(
  record: AgentSessionRecord,
  write: TerminalSwitchWrite,
  now: number
): AgentSessionRecord {
  const current = record.terminalSwitch?.generation
  if ('clear' in write) {
    if (current !== write.clear) {
      return record
    }
    const next = { ...record, updatedAt: now }
    delete next.terminalSwitch
    return next
  }
  const descriptor = 'accept' in write ? write.accept : write.update
  const applies = current === descriptor.generation || ('accept' in write && current === undefined)
  return applies ? { ...record, terminalSwitch: descriptor, updatedAt: now } : record
}
