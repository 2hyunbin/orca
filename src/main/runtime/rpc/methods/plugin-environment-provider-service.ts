import { sshTargetStackAvailable } from '../../../ssh/ssh-target-registry'
import { environmentProviderSshAuthorizerAvailable } from '../../../ssh/environment-provider-ssh-admission'
import type { PluginEnvironmentProviderService } from '../../../plugins/plugin-environment-provider-service'
import { environmentProviderControllerForService } from '../../../plugins/plugin-environment-provider-controller'

let service: PluginEnvironmentProviderService | null = null

export function setEnvironmentProviderServiceForRpc(
  next: PluginEnvironmentProviderService | null
): void {
  service = next
}

export function environmentProviderRpcAvailable(): boolean {
  return service !== null
}

export function requireEnvironmentProviderRpcController() {
  if (!service) {
    throw new Error('Environment providers are unavailable on this control host')
  }
  return environmentProviderControllerForService(service)
}

export function environmentProviderSshRpcAvailable(): boolean {
  return (
    service !== null && sshTargetStackAvailable() && environmentProviderSshAuthorizerAvailable()
  )
}
