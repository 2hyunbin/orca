import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const recordCoalescedDurableCrashBreadcrumb = vi.fn()
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordCoalescedDurableCrashBreadcrumb: (...args: unknown[]) =>
    recordCoalescedDurableCrashBreadcrumb(...args)
}))

import { trackRendererLivenessAtDeath } from './renderer-liveness-at-death'

function createWindow(state: { minimized?: boolean; visible?: boolean; destroyed?: boolean } = {}) {
  const contents = new EventEmitter()
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => state.destroyed === true,
    isMinimized: () => state.minimized === true,
    isVisible: () => state.visible !== false,
    isFocused: () => false
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tracker only reads the emitter API and the four getters stubbed above.
  return { window: window as unknown as Electron.BrowserWindow, contents }
}

describe('trackRendererLivenessAtDeath', () => {
  let now = 0
  beforeEach(() => {
    now = 1_000
    recordCoalescedDurableCrashBreadcrumb.mockClear()
  })

  it('reports a document that never loaded as a blank window with its age', () => {
    const { window, contents } = createWindow()
    const tracker = trackRendererLivenessAtDeath(window, () => now)
    contents.emit('did-navigate')
    now += 866_000

    expect(tracker.read()).toEqual({
      rendererDocumentLoaded: false,
      rendererDocumentAgeMs: 866_000,
      mainWindowState: 'visible',
      mainWindowFocused: false
    })
  })

  it('reports how long the renderer has been hung, and clears it on responsive', () => {
    const { window, contents } = createWindow({ minimized: true })
    const tracker = trackRendererLivenessAtDeath(window, () => now)
    contents.emit('did-finish-load')
    window.emit('unresponsive')
    now += 5_000
    window.emit('unresponsive')
    now += 40_000

    expect(tracker.read()).toMatchObject({
      rendererUnresponsiveForMs: 45_000,
      rendererDocumentLoaded: true,
      mainWindowState: 'minimized'
    })
    expect(recordCoalescedDurableCrashBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'renderer_unresponsive' })
    )

    window.emit('responsive')
    expect(tracker.read().rendererUnresponsiveForMs).toBeUndefined()
    expect(recordCoalescedDurableCrashBreadcrumb).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'renderer_responsive', data: { hungForMs: 45_000 } })
    )
  })

  it('does not carry a hang into the next document after a recovery reload', () => {
    const { window, contents } = createWindow()
    const tracker = trackRendererLivenessAtDeath(window, () => now)
    window.emit('unresponsive')
    contents.emit('did-navigate')

    expect(tracker.read().rendererUnresponsiveForMs).toBeUndefined()
  })

  it('omits window state instead of throwing for a destroyed window', () => {
    const { window } = createWindow({ destroyed: true })
    const tracker = trackRendererLivenessAtDeath(window, () => now)

    expect(tracker.read()).toEqual({ rendererDocumentLoaded: false, rendererDocumentAgeMs: 0 })
  })
})
