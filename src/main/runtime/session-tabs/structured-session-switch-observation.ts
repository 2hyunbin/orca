import type {
  AgentProcessIdentity,
  AgentProcessVerdict
} from '../../../shared/agent-process-presence'
import {
  probeAgentProcessPresence,
  readAgentProcess
} from '../../../shared/agent-process-presence-probe'
import {
  buildProcessTableIndex,
  collectDescendantsFromIndex
} from '../../../shared/process-table-index'
import { getFreshShellForegroundSnapshot } from '../../../shared/process-table-snapshot-reader'
import {
  isWindowsProcessStartTimeAvailable,
  readWindowsProcessCreationTime,
  readWindowsProcessIdentityTableFresh,
  readWindowsProcessTableFresh
} from '../../windows/windows-process-table'

/** The processes below a pane's shell whose command line names the conversation: what the switch
 *  typed there. Session leaders left the terminal (a prompt's worker), so they are not its job. */
export async function readSwitchPaneAgentProcesses(
  rootPid: number,
  conversationId: string
): Promise<AgentProcessIdentity[]> {
  if (process.platform === 'win32') {
    if (!isWindowsProcessStartTimeAvailable()) {
      return []
    }
    const index = buildProcessTableIndex(await readWindowsProcessTableFresh())
    return collectDescendantsFromIndex(index, rootPid).flatMap((row) =>
      row.command.includes(conversationId) && row.creationTimeMs
        ? [{ pid: row.pid, platform: 'win32' as const, startTime: String(row.creationTimeMs) }]
        : []
    )
  }
  const platform = process.platform
  if (platform !== 'darwin' && platform !== 'linux') {
    return []
  }
  const index = buildProcessTableIndex(await getFreshShellForegroundSnapshot())
  const named = collectDescendantsFromIndex(index, rootPid, (row) => row.stat.includes('s')).filter(
    (row) => row.command.includes(conversationId)
  )
  const identities = await Promise.all(
    named.map(async (row) => {
      const observed = await readAgentProcess(row.pid)
      return observed.verdict === 'live' && !observed.zombie
        ? [{ pid: row.pid, platform, startTime: observed.startTime }]
        : []
    })
  )
  return identities.flat()
}

/** `exited` only on proof: the pid is gone or now names a different process. */
export async function switchStartProcessVerdict(
  identity: AgentProcessIdentity
): Promise<AgentProcessVerdict> {
  if (identity.platform !== 'win32') {
    return probeAgentProcessPresence(identity)
  }
  if (process.platform !== 'win32' || !isWindowsProcessStartTimeAvailable()) {
    return 'unverifiable'
  }
  const created = readWindowsProcessCreationTime(identity.pid)
  if (created !== null) {
    return String(created) === identity.startTime ? 'live' : 'exited'
  }
  // An unreadable pid is not an absent one: only a fresh table's own listing proves it is gone.
  const rows = await readWindowsProcessIdentityTableFresh().catch(() => [])
  const row = rows.find((candidate) => candidate.pid === identity.pid)
  if (rows.length > 0 && !row) {
    return 'exited'
  }
  return row?.creationTimeMs && String(row.creationTimeMs) !== identity.startTime
    ? 'exited'
    : 'unverifiable'
}
