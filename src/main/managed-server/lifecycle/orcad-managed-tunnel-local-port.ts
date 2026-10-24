// A saved tunnel port can become unbindable: a Windows excluded port range or another app's listener.
import { moveManagedOrcadLocalPort } from '../../../shared/runtime-environment-managed-orcad-store'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import {
  getOrcadSshDeployment,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { reserveLocalForwardPort } from '../../ssh/system-transport/system-ssh-forward-port-reservation'
import { pairingRevisionOf } from './orcad-managed-pairing-repair'

// Reservation reports the bind error code as `cause`; Windows excluded ranges answer EACCES.
const UNBINDABLE_LOCAL_PORT_CODES = new Set<unknown>(['EADDRINUSE', 'EACCES'])

/**
 * Builds once more on a free local port when the saved one cannot be bound. The port is local to
 * this desktop, so the move keeps the pairing, the server's identity and its projects.
 */
export async function buildOnBindableLocalPort(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  build: (environment: KnownRuntimeEnvironment) => Promise<void>
): Promise<void> {
  try {
    await build(environment)
  } catch (error) {
    const saved = getOrcadSshDeployment(environment)?.localPort
    if (
      saved === undefined ||
      !(error instanceof Error) ||
      !UNBINDABLE_LOCAL_PORT_CODES.has(error.cause)
    ) {
      throw error
    }
    const localPort = await reserveLocalForwardPort(0)
    const current = resolveEnvironment(userDataPath, environment.id)
    // A concurrent build or repair already rebound this server; build on what it saved.
    if (
      pairingRevisionOf(current) !== pairingRevisionOf(environment) ||
      getOrcadSshDeployment(current)?.localPort !== saved
    ) {
      return build(current)
    }
    console.warn(
      `[ssh] Moving the tunnel to this host’s Orca server from local port ${saved} to ${localPort}: ${error.message}`
    )
    await build(moveManagedOrcadLocalPort(userDataPath, environment.id, localPort))
  }
}
