/** After a managed connect or restore: flags a macOS host whose server outlived its launching SSH session. */
import { getAppEnvironment } from '../../shared/app-environment'
import { readManagedOrcadLaunchSshSession } from '../ssh/orcad-managed-launch-session'
import { knownSshHostPlatform } from '../ssh/ssh-host-platform-memo'
import { getSshHostServerStatus } from '../ssh/ssh-host-server-status'
import { connectionManager } from './ssh-ipc-context'
import { publishHostServerStatus } from './runtime-environment-managed-tunnel'

// Once per SSH connection: a restore runs on every runtime call, and the answer only changes
// when a session ends, which a reconnect (a new connection) then checks.
const checkedConnections = new WeakSet<object>()

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
  if (!connection || checkedConnections.has(connection)) {
    return
  }
  checkedConnections.add(connection)
  try {
    const session = await readManagedOrcadLaunchSshSession(
      getAppEnvironment().getPath('userData'),
      environmentId
    )
    const status = getSshHostServerStatus(targetId)
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
