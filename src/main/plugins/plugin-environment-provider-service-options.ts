import type { PluginService } from './plugin-service'
import type { PluginServiceOptions } from './plugin-service-options'
import { PluginEnvironmentProviderService } from './plugin-environment-provider-service'

export function createEnvironmentProviderService(
  service: PluginService,
  options: PluginServiceOptions,
  onChanged?: (providerId: string) => void
): PluginEnvironmentProviderService {
  return new PluginEnvironmentProviderService({
    service,
    onChanged,
    retireConnections: options.retireEnvironmentProviderConnections,
    retireTarget: options.retireEnvironmentProviderSshTarget,
    adapterRuntime: options.environmentAdapterRuntime,
    userDataPath: options.userDataPath,
    launchEnvironment:
      options.getEnvironmentRecipeLaunchEnvironment ?? (async () => ({ ...process.env }))
  })
}
