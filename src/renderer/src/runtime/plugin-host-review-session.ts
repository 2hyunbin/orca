import type { PluginChangeEvent } from '../../../shared/plugins/plugin-change-event'
import type { PluginEnvironmentProviderSessionOpen } from '../../../shared/plugins/plugin-environment-provider-session'

export async function openPluginHostReview(
  input: PluginEnvironmentProviderSessionOpen,
  onRetired: () => void,
  signal: AbortSignal
) {
  const bridge = window.api.plugins
  const open = bridge.openEnvironmentProviderSession
  const stop = bridge.closeEnvironmentProviderSession
  if (
    !open ||
    !stop ||
    !bridge.onEnvironmentProviderSessionRetired ||
    !bridge.onEnvironmentProviderSessionChanged
  ) {
    throw new Error('Update Orca to review plugins on the selected host')
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
      throw new Error('The plugin review connection is no longer available')
    }
  }
  try {
    current()
    const ready = await open(expected)
    current()
    if (ready.sessionId !== expected.sessionId || ready.runtimeId !== expected.runtimeId) {
      throw new Error('The plugin review belongs to another host or server instance')
    }
  } catch (error) {
    close()
    throw error
  }
  return {
    current,
    close,
    onChanged: (listener: (change: PluginChangeEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
