import { errorMessage } from '../../shared/error-message'
import type { WslHostServerStop } from '../../shared/wsl-host-types'
import type { WslHostConnector } from './wsl-host-service'

/** A Remove's teardown; without its holder the distro idles out. */
export async function tearDownRemovedWslHost(
  connector: Pick<WslHostConnector, 'stopServer' | 'disconnect' | 'releaseHolder'>,
  distro: string,
  environmentId: string
): Promise<WslHostServerStop> {
  const serverStop = await connector
    .stopServer(distro, environmentId)
    .catch((error: unknown): WslHostServerStop => ({ stopped: false, reason: errorMessage(error) }))
  await connector.disconnect(distro)
  await connector.releaseHolder(distro)
  return serverStop
}
