import type { PluginEnvironmentHostApi } from './plugin-environment-provider-client-api'
import type { PluginChangeEvent } from '../../../shared/plugins/plugin-change-event'
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
  const bridge = window.api.plugins
  const open = bridge.openEnvironmentProviderSession
  const invoke = bridge.callEnvironmentProviderSession
  const stop = bridge.closeEnvironmentProviderSession
  if (
    !open ||
    !invoke ||
    !stop ||
    !bridge.onEnvironmentProviderSessionRetired ||
    !bridge.onEnvironmentProviderSessionChanged
  ) {
    throw new Error('Update Orca to manage providers on the selected host')
  }
  const expected = { ...input }
  let retired = false
  const listeners = new Set<(change: PluginChangeEvent) => void>()
  const cleanup: (() => void)[] = []
  const close = (): void => {
    if (retired) {
      return
    }
    retired = true
    for (const release of cleanup) {
      release()
    }
    listeners.clear()
    signal.removeEventListener('abort', close)
    void stop({ sessionId: expected.sessionId }).catch(() => undefined)
  }
  const invalidate = (): void => {
    close()
    onRetired()
  }
  cleanup.push(
    bridge.onEnvironmentProviderSessionRetired((event) => {
      if (event.sessionId === expected.sessionId && !retired) {
        invalidate()
      }
    })
  )
  cleanup.push(
    bridge.onEnvironmentProviderSessionChanged((event) => {
      if (event.sessionId === expected.sessionId && !retired) {
        for (const listener of listeners) {
          listener(event.change)
        }
      }
    })
  )
  signal.addEventListener('abort', close, { once: true })
  const current = (): void => {
    signal.throwIfAborted()
    if (retired) {
      throw new Error('The provider review connection is no longer available')
    }
  }
  try {
    current()
    const ready = await open(expected)
    current()
    if (ready.sessionId !== expected.sessionId || ready.runtimeId !== expected.runtimeId) {
      throw new Error('The provider review belongs to another host or server instance')
    }
  } catch (error) {
    close()
    throw error
  }
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
    onChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return { api, close }
}
