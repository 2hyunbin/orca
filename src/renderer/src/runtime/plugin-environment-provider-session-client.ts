import type { PluginEnvironmentHostApi } from './plugin-environment-provider-client-api'
import { openPluginHostReview } from './plugin-host-review-session'
import type { PluginEnvironmentProviderSessionOpen } from '../../../shared/plugins/plugin-environment-provider-session'
import type {
  EnvironmentProviderRuntimeMethod,
  EnvironmentProviderRuntimeInput
} from '../../../shared/plugins/plugin-environment-provider-runtime-calls'

export async function openPluginEnvironmentProviderSession(
  input: PluginEnvironmentProviderSessionOpen,
  onRetired: () => void,
  signal: AbortSignal
): Promise<{ api: PluginEnvironmentHostApi; close(): void }> {
  const invoke = window.api.plugins.callEnvironmentProviderSession
  if (!invoke) {
    throw new Error('Update Orca to manage providers on the selected host')
  }
  const { current, close, onChanged, sshSupported } = await openPluginHostReview(
    input,
    onRetired,
    signal
  )
  const expected = { ...input }
  const call = async <Method extends EnvironmentProviderRuntimeMethod>(
    method: Method,
    args: EnvironmentProviderRuntimeInput<Method>
  ) => {
    current()
    const result = await invoke({ sessionId: expected.sessionId, method, input: args })
    current()
    return result
  }
  const api: PluginEnvironmentHostApi = {
    ...(sshSupported
      ? {
          prepareEnvironmentProviderSsh: (
            args: Parameters<
              NonNullable<PluginEnvironmentHostApi['prepareEnvironmentProviderSsh']>
            >[0]
          ) => call('prepareSsh', { input: args }),
          saveEnvironmentProviderSsh: (
            args: Parameters<NonNullable<PluginEnvironmentHostApi['saveEnvironmentProviderSsh']>>[0]
          ) => call('saveSsh', { input: args }),
          discardEnvironmentProviderSshReview: (
            args: Parameters<
              NonNullable<PluginEnvironmentHostApi['discardEnvironmentProviderSshReview']>
            >[0]
          ) => call('discardSsh', { input: args }),
          connectEnvironmentProviderSsh: (
            args: Parameters<
              NonNullable<PluginEnvironmentHostApi['connectEnvironmentProviderSsh']>
            >[0]
          ) => call('connectSsh', { input: args })
        }
      : {}),
    listEnvironmentProviders: () => call('list', {}),
    listSavedEnvironmentProviders: () => call('listSaved', {}),
    configureEnvironmentProvider: (review) => call('configure', { input: review }),
    environmentProviderSnapshot: (review) => call('snapshot', { input: review }),
    savedEnvironmentProviderSnapshot: (args) => call('savedSnapshot', { input: args }),
    previousEnvironmentProviderSnapshot: (args) => call('previousSnapshot', { input: args }),
    executeEnvironmentProvider: (args) => call('execute', { input: args }),
    recoverEnvironmentProvider: (args) => call('recover', { input: args }),
    cancelEnvironmentProvider: (args) => call('cancel', { input: args }),
    prepareEnvironmentProviderMigration: (args) => call('prepareMigration', { input: args }),
    commitEnvironmentProviderMigration: (args) => call('commitMigration', { input: args }),
    onChanged
  }
  return { api, close }
}
