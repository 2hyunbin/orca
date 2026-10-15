import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'

export function probeProviderProcessGroup(pgid: number): DescendantTreeVerdict {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) {
    return 'unverifiable'
  }
  try {
    process.kill(-pgid, 0)
    return 'live'
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
      ? 'exited'
      : 'unverifiable'
  }
}

/** Rootless group liveness is not proof of identity or authority to signal it. */
export function providerGroupOutlivedRoot(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH' &&
      probeProviderProcessGroup(pid) === 'live'
  }
}

/** Restart and recovery must use the same boundary as managed process completion. */
export function retainProviderGroupProbe(
  pid: number,
  probe: AgentSessionOwnerProbe,
  platform: NodeJS.Platform = process.platform,
  groupProbe = probeProviderProcessGroup
): AgentSessionOwnerProbe {
  if (platform !== 'win32' && probe.outcome === 'pid-absent' && groupProbe(pid) !== 'exited') {
    return { outcome: 'indeterminate', reason: 'provider root exited but group cleanup is unconfirmed' }
  }
  return probe
}
