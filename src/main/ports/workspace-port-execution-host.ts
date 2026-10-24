import {
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type {
  WorkspacePortHostKillRequest,
  WorkspacePortHostScanResult,
  WorkspacePortKillResult,
  WorkspacePortProbe
} from '../../shared/workspace-ports'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../providers/ssh-host-not-served-error'
import { killWorkspacePort, scanWorkspacePortProbes } from './workspace-port-ownership'

export type WorkspacePortExecutionHostDeps = {
  /** Workspaces this host runs itself; the only processes Stop may signal here. */
  getLocalProbes: () => Promise<WorkspacePortProbe[]>
}

function unavailable(executionHostId: string, reason: string): WorkspacePortHostScanResult {
  return {
    executionHostId,
    platform: 'unknown',
    scannedAt: Date.now(),
    ports: [],
    unavailableReason: reason
  }
}

export async function scanWorkspacePortsOnExecutionHost(
  executionHostId: ExecutionHostId,
  deps: WorkspacePortExecutionHostDeps
): Promise<WorkspacePortHostScanResult> {
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind === 'local') {
    return { ...(await scanWorkspacePortProbes(await deps.getLocalProbes())), executionHostId }
  }
  // Unserved SSH listeners are unverifiable, never an empty scan.
  if (host?.kind === 'ssh') {
    return unavailable(
      executionHostId,
      `Could not scan the SSH host: ${SSH_HOST_NOT_SERVED_MESSAGE}`
    )
  }
  return unavailable(executionHostId, 'This workspace does not run on this server.')
}

/** Signal only when current workspace host matches scanned host; PID numbers can repeat across machines. */
export async function killWorkspacePortOnExecutionHost(
  resolvedHostId: ExecutionHostId,
  request: Omit<WorkspacePortHostKillRequest, 'worktree'>,
  deps: WorkspacePortExecutionHostDeps
): Promise<WorkspacePortKillResult> {
  if (normalizeExecutionHostId(request.executionHostId) !== resolvedHostId) {
    return {
      ok: false,
      reason: 'This port was found on a different host than the workspace runs on. Rescan first.'
    }
  }
  const host = parseExecutionHostId(resolvedHostId)
  if (host?.kind === 'local') {
    return killWorkspacePort(await deps.getLocalProbes(), { pid: request.pid, port: request.port })
  }
  // Unserved SSH ownership cannot authorize Stop; refuse rather than signal this machine.
  if (host?.kind === 'ssh') {
    return { ok: false, reason: 'Stopping processes on an SSH host is not supported yet.' }
  }
  return { ok: false, reason: 'This workspace does not run on this server.' }
}
