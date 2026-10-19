import { afterEach, expect, it, vi } from 'vitest'
import { ipcRenderer } from 'electron'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcRenderer: Object.assign(new EventEmitter(), { send: vi.fn() }) }
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function setup() {
  vi.resetModules()
  ipcRenderer.removeAllListeners()
  vi.mocked(ipcRenderer.send).mockClear()
  const document = new EventTarget()
  vi.stubGlobal('window', document)
  const transport = await import('./pty-renderer-page-transport')
  const correlation = vi.mocked(ipcRenderer.send).mock.calls[0]?.[1].correlation
  return { document, transport, correlation }
}

it('rejects foreign endpoints and dispatches queued attachment and spawn calls in order', async () => {
  const { document, transport, correlation } = await setup()
  const foreign = { start: vi.fn(), close: vi.fn() }
  ipcRenderer.emit(
    'pty:rendererPageTransport',
    { ports: [foreign] },
    { correlation: 'old', page: 'old' }
  )
  expect(foreign.close).toHaveBeenCalledOnce()
  transport.sendRendererPage('pty:updateRendererAttachment', { key: 'pane' })
  const invoke = vi.fn(() => vi.mocked(ipcRenderer.send).mock.calls.at(-1))
  const pending = transport.dispatchRendererPage(invoke)
  expect(invoke).not.toHaveBeenCalled()
  const port = { start: vi.fn(), close: vi.fn() }
  ipcRenderer.emit('pty:rendererPageTransport', { ports: [port] }, { correlation, page: 'current' })
  await expect(pending).resolves.toEqual([
    'pty:updateRendererAttachment',
    { key: 'pane', page: 'current' }
  ])
  expect(invoke).toHaveBeenCalledWith('current')
  expect(port.start).toHaveBeenCalledOnce()
  const stale = transport.dispatchRendererPage(invoke)
  document.dispatchEvent(new Event('pagehide'))
  await expect(stale).rejects.toThrow('ended with its document')
  expect(invoke).toHaveBeenCalledOnce()
  expect(port.close).toHaveBeenCalledOnce()
})

it('ends outstanding setup on departure and closes a late endpoint without dispatching', async () => {
  const { document, transport, correlation } = await setup()
  const invoke = vi.fn()
  const pending = transport.dispatchRendererPage(invoke)
  document.dispatchEvent(new Event('pagehide'))
  await expect(pending).rejects.toThrow('ended with its document')
  const port = { start: vi.fn(), close: vi.fn() }
  ipcRenderer.emit('pty:rendererPageTransport', { ports: [port] }, { correlation, page: 'late' })
  expect(port.close).toHaveBeenCalledOnce()
  expect(port.start).not.toHaveBeenCalled()
  expect(invoke).not.toHaveBeenCalled()
})
