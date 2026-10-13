import { afterEach, expect, it, vi } from 'vitest'
import { setTrustedBrowserRendererWebContentsId } from './browser-renderer-trust'
type Handler = (event: unknown, ...args: unknown[]) => unknown
const captured = vi.hoisted(() => {
  const state: { handler: Handler | null } = { handler: null }
  return state
})
vi.mock('electron', () => ({
  ipcMain: {
    handle: (_channel: string, handler: Handler) => {
      captured.handler = handler
    }
  }
}))
import { registerPluginRendererHandler } from './plugin-renderer-ipc'
afterEach(() => {
  setTrustedBrowserRendererWebContentsId(null)
  captured.handler = null
})
it('requires the actual app window and main frame before dispatching management work', () => {
  setTrustedBrowserRendererWebContentsId(1)
  const operation = vi.fn(() => 'result')
  registerPluginRendererHandler('plugins:consent', operation)
  const handler = captured.handler
  if (!handler) {
    throw new Error('Missing handler')
  }
  const mainFrame = {},
    sender = {
      id: 1,
      mainFrame,
      getType: () => 'window',
      getURL: () => 'file:///orca/index.html',
      isDestroyed: () => false
    }
  for (const event of [
    { sender: { ...sender, id: 2 }, senderFrame: mainFrame },
    { sender: { ...sender, getType: () => 'webview' }, senderFrame: mainFrame },
    { sender, senderFrame: {} },
    { sender, senderFrame: null },
    { sender: { ...sender, isDestroyed: () => true }, senderFrame: mainFrame }
  ]) {
    expect(() => handler(event, { decision: 'approve' })).toThrow('trusted application window')
  }
  expect(operation).not.toHaveBeenCalled()
  const event = { sender, senderFrame: mainFrame }
  expect(handler(event, { decision: 'approve' })).toBe('result')
  expect(operation).toHaveBeenCalledExactlyOnceWith(event, { decision: 'approve' })
})
