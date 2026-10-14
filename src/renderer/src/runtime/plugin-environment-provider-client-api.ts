import type { PluginsApi } from '../../../preload/api/plugin-host-api'

export type PluginEnvironmentHostApi = Pick<
  PluginsApi,
  | 'listEnvironmentProviders'
  | 'listSavedEnvironmentProviders'
  | 'configureEnvironmentProvider'
  | 'environmentProviderSnapshot'
  | 'savedEnvironmentProviderSnapshot'
  | 'previousEnvironmentProviderSnapshot'
  | 'executeEnvironmentProvider'
  | 'recoverEnvironmentProvider'
  | 'cancelEnvironmentProvider'
  | 'prepareEnvironmentProviderMigration'
  | 'commitEnvironmentProviderMigration'
  | 'prepareEnvironmentProviderSsh'
  | 'saveEnvironmentProviderSsh'
  | 'discardEnvironmentProviderSshReview'
  | 'onChanged'
>
