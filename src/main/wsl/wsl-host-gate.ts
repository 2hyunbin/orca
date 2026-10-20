import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getWslHostService } from './wsl-host-service-instance'
import { isWslHostsInternalGateOpen } from '../../shared/wsl-host-internal-gate'
import type { OrcadDeploymentLink } from '../../shared/runtime-environments'

export const WSL_HOSTS_GATED_OFF_MESSAGE = 'WSL hosts are not available in this build.'

export function wslHostsGateOpen(): boolean {
  return isWslHostsInternalGateOpen(process.env)
}

/** A persisted WSL host while the gate is closed: left on disk, but never listed or reached. */
export function isGatedOffWslHost(environment: {
  orcadDeployment?: OrcadDeploymentLink | null
}): boolean {
  return environment.orcadDeployment?.kind === 'wsl' && !wslHostsGateOpen()
}

export function assertWslHostReachable(environment: {
  orcadDeployment?: OrcadDeploymentLink | null
}): void {
  if (isGatedOffWslHost(environment)) {
    throw new Error(WSL_HOSTS_GATED_OFF_MESSAGE)
  }
}

export function wslProjectRoutingEnabled(
  store: { getRepos(): unknown[]; getSettings?(): Pick<GlobalSettings, 'experimentalWslHosts'> },
  executionHostId?: ExecutionHostId | null
): boolean {
  return (
    process.platform === 'win32' &&
    (executionHostId == null || executionHostId === LOCAL_EXECUTION_HOST_ID) &&
    wslHostsGateOpen() &&
    (getWslHostService()?.isEnabled() ?? store.getSettings?.().experimentalWslHosts === true)
  )
}
