/** After a managed connect or restore: flags a macOS host whose server outlived its launching SSH session. */
import { getAppEnvironment } from '../../shared/app-environment'
import { readManagedOrcadLaunchSshSession } from '../ssh/orcad-managed-launch-session'
import { knownSshHostPlatform } from '../ssh/ssh-host-platform-memo'
import { getSshHostServerStatus } from '../ssh/ssh-host-server-status'
import { connectionManager } from './ssh-ipc-context'
import { publishHostServerStatus } from './runtime-environment-managed-tunnel'

// Once per SSH session: a restore runs on every runtime call, and the answer only changes when
// a session ends, which the next session (a new connection or reconnect generation) checks.
const checkedGenerations = new WeakMap<object, number>()

/** Never blocks or fails the caller; anything but a proven exit shows nothing. */
export async function noteEndedLaunchSshSession(
  targetId: string,
  environmentId: string
): Promise<void> {
  // Why the memo: Linux and Windows hosts cost no extra round trip; the tunnel build fills it.
  if (knownSshHostPlatform(targetId)?.os !== 'darwin') {
    return
  }
  const connection = connectionManager?.getConnection(targetId)
  const generation = connection?.getConnectGeneration()
  if (!connection || checkedGenerations.get(connection) === generation) {
    return
  }
  checkedGenerations.set(connection, generation ?? 0)
  try {
    const session = await readManagedOrcadLaunchSshSession(
      getAppEnvironment().getPath('userData'),
      environmentId
    )
    const status = getSshHostServerStatus(targetId)
    if (status?.kind === 'setting-up') {
      // A start or update is still deciding; a later call checks again.
      checkedGenerations.delete(connection)
      return
    }
    // A restored host may have no status yet; any other server decision is left alone.
    if (
      session === 'exited' &&
      (!status ||
        (status.kind === 'managed' && status.environmentId === environmentId && !status.serving))
    ) {
      publishHostServerStatus(targetId, {
        ...(status ?? { kind: 'managed', environmentId }),
        launchSessionEnded: true
      })
    }
  } catch (error) {
    console.warn('[ssh] Could not check which SSH session started the managed server:', error)
  }
}
