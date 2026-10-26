/**
 * Readies a distro's WSL host for an automatic move step (D3a), never booting the distro (A1):
 * only a distro the running-distro read confirms gets its host connected, or added for a bridge
 * user who never added one. A failed read proves nothing, so it never counts as stopped.
 */
import type { WslRunningDistrosRead } from '../../wsl-background-distro-gate'
import { wslMoveJournalKey } from '../../../shared/wsl-move/wsl-move-cutover'
import type { WslHostAddResult } from '../../../shared/wsl-host-types'
import type { WslMoveHostReadiness } from './wsl-move-orchestrator'

export type WslMoveHostReadinessDeps = {
  readRunningDistros: () => Promise<WslRunningDistrosRead>
  isHostReady: (distro: string) => boolean
  hasHost: (distro: string) => boolean
  /** Connects an added host; called only for a confirmed-running distro. */
  connect: (distro: string) => Promise<void>
  /** Adds a host without starting a stopped distro. */
  add: (distro: string) => Promise<WslHostAddResult>
}

export async function prepareWslMoveHost(
  deps: WslMoveHostReadinessDeps,
  distro: string
): Promise<WslMoveHostReadiness> {
  const running = await deps
    .readRunningDistros()
    .catch((): WslRunningDistrosRead => ({ status: 'unavailable' }))
  if (running.status !== 'confirmed') {
    return 'unverifiable'
  }
  const key = wslMoveJournalKey(distro)
  if (!running.distros.some((candidate) => wslMoveJournalKey(candidate) === key)) {
    return 'not-running'
  }
  if (deps.isHostReady(distro)) {
    return 'ready'
  }
  try {
    if (deps.hasHost(distro)) {
      await deps.connect(distro)
    } else if (!(await deps.add(distro)).ok) {
      return 'failed'
    }
  } catch {
    return 'failed'
  }
  return deps.isHostReady(distro) ? 'ready' : 'failed'
}
