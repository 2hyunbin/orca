/**
 * Restarting a daemon whose AppImage files are gone ends every process it hosts, so the action
 * re-reads the host's own evidence right before acting: it proceeds only when the pid record and
 * `/proc` still name the exact incarnation the user was shown.
 */
import { getDaemonRuntimeDir } from './daemon-launch-paths'
import { readDaemonPidRecord } from './daemon-endpoint-incarnation'
import { inspectDaemonHostImage } from './daemon-host-image'
import {
  clearSeveredDaemon,
  getSeveredDaemon,
  isSameIncarnation,
  type SeveredDaemonController,
  type SeveredDaemonIncarnation,
  type SeveredDaemonRestartResult
} from './daemon-host-image-state'
import { getCurrentDaemonAdapter } from './daemon-provider-routing'
import { restartDaemon } from './daemon-provider-restart'
import { getDaemonProvider } from './daemon-provider-state'
import { getDaemonPidPath } from './daemon-spawner'

type Dependencies = {
  inspect: () => ReturnType<typeof inspectDaemonHostImage>
  restart: () => Promise<{ killedCount: number }>
  listSessions: () => Promise<{ isAlive: boolean }[]>
}

const defaultDependencies: Dependencies = {
  inspect: () =>
    inspectDaemonHostImage(readDaemonPidRecord(getDaemonPidPath(getDaemonRuntimeDir()))),
  restart: restartDaemon,
  listSessions: async () => {
    const provider = getDaemonProvider()
    return provider ? getCurrentDaemonAdapter(provider).listSessions() : []
  }
}

export function createSeveredDaemonController(
  dependencies: Dependencies = defaultDependencies
): SeveredDaemonController {
  return {
    countLiveSessions: async () => {
      try {
        return (await dependencies.listSessions()).filter((session) => session.isAlive).length
      } catch {
        return null
      }
    },
    restart: async (expected) => restartVerifiedSeveredDaemon(expected, dependencies)
  }
}

async function restartVerifiedSeveredDaemon(
  expected: SeveredDaemonIncarnation,
  dependencies: Dependencies
): Promise<SeveredDaemonRestartResult> {
  const current = dependencies.inspect()
  if (current.verdict === 'unknown') {
    return { status: 'refused', reason: 'unverifiable' }
  }
  if (
    current.pid === null ||
    !current.linuxStartTicks ||
    !current.bootId ||
    !isSameIncarnation(
      { pid: current.pid, linuxStartTicks: current.linuxStartTicks, bootId: current.bootId },
      expected
    )
  ) {
    clearSeveredDaemon()
    return { status: 'refused', reason: 'replaced' }
  }
  const { killedCount } = await dependencies.restart()
  clearSeveredDaemon()
  return { status: 'restarted', killedCount }
}

/** True once the endpoint's pid record names a verified incarnation other than the severed one. */
export function hasSeveredDaemonBeenReplaced(
  pidPath: string,
  inspect: (pidPath: string) => ReturnType<typeof inspectDaemonHostImage> = (path) =>
    inspectDaemonHostImage(readDaemonPidRecord(path))
): boolean {
  const severed = getSeveredDaemon()
  if (!severed) {
    return true
  }
  const current = inspect(pidPath)
  if (
    current.verdict === 'unknown' ||
    current.verdict === 'severed' ||
    current.pid === null ||
    !current.linuxStartTicks ||
    !current.bootId ||
    isSameIncarnation(
      { pid: current.pid, linuxStartTicks: current.linuxStartTicks, bootId: current.bootId },
      severed
    )
  ) {
    return false
  }
  clearSeveredDaemon()
  return true
}
