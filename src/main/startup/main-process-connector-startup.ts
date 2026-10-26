import { createDesktopConnectorCloud } from '../connector-cloud/connector-cloud-install'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { mainProcessState as state } from './main-process-state'

// Desktop only: the connector acts as the signed-in Orca account, which `orca serve` does not have yet.
export function startDesktopConnectorCloud(): void {
  if (!state.runtime || !state.store) {
    return
  }
  state.connectorCloud = createDesktopConnectorCloud(
    state.runtime,
    state.store,
    getProfileUserDataPath()
  )
  state.connectorCloud?.connect()
}
