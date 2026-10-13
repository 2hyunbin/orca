// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { attachPluginViewerWebview } from './plugin-viewer-webview'
import type { PluginViewerUnavailable } from '../../../../shared/plugins/plugin-viewer-unavailable'

vi.mock('../browser-pane/host-guest/webview-registry', () => ({
  registerPersistentWebview: vi.fn(),
  unregisterPersistentWebview: vi.fn(),
  webviewRegistry: new Map()
}))
afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

it('binds main-owned resource failures to the exact lease and cancels the destruction fallback', () => {
  vi.useFakeTimers()
  let unavailable: ((event: PluginViewerUnavailable) => void) | undefined
  const unsubscribe = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        onViewerUnavailable(callback: typeof unavailable) {
          unavailable = callback
          return unsubscribe
        }
      }
    }
  })
  const container = document.createElement('div')
  document.body.append(container)
  const lease = {
    id: 'c7a2463e-4d17-4595-9a8e-000000000001',
    partition: 'test',
    url: 'orca-plugin-viewer://test/'
  }
  const onStatus = vi.fn()
  const dispose = attachPluginViewerWebview({
    container,
    identity: 'test',
    lease,
    label: 'test',
    onStatus
  })
  unavailable?.({ leaseId: 'c7a2463e-4d17-4595-9a8e-000000000002', code: 'limit_exceeded' })
  expect(onStatus).not.toHaveBeenCalled()
  container.firstElementChild?.dispatchEvent(new Event('destroyed'))
  unavailable?.({ leaseId: lease.id, code: 'limit_exceeded' })
  vi.advanceTimersByTime(100)
  expect(onStatus).toHaveBeenCalledExactlyOnceWith({ type: 'error', code: 'limit_exceeded' })
  dispose()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(container.children).toHaveLength(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('cancels a pending generic error when the pane detaches before delivery', () => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'api', { configurable: true, value: { plugins: {} } })
  const container = document.createElement('div')
  const onStatus = vi.fn()
  const dispose = attachPluginViewerWebview({
    container,
    identity: 'test',
    label: 'test',
    onStatus,
    lease: { id: 'test', partition: 'test', url: 'orca-plugin-viewer://test/' }
  })
  container.firstElementChild?.dispatchEvent(new Event('destroyed'))
  dispose()
  vi.advanceTimersByTime(100)
  expect(onStatus).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
