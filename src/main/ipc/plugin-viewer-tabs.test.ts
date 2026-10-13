import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import { pluginViewerOpenResponseSchema } from '../../shared/plugins/plugin-viewer-open'

const dependencies = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: { sender: object; senderFrame: object }, raw: unknown) => Promise<unknown>
  >(),
  trusted: vi.fn(),
  resolveFile: vi.fn(),
  bootstrap: vi.fn(),
  create: vi.fn(),
  close: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/isolated-client' },
  ipcMain: {
    handle: (name: string, handler: Parameters<typeof dependencies.handlers.set>[1]) =>
      dependencies.handlers.set(name, handler)
  }
}))
vi.mock('./browser-renderer-trust', () => ({ isTrustedBrowserRenderer: dependencies.trusted }))
vi.mock('./local-file-access-resolution', () => ({
  resolveLocalFileRequestPath: dependencies.resolveFile
}))
vi.mock('../plugins/plugin-viewer-bootstrap', () => ({
  createPluginViewerBootstrap: dependencies.bootstrap
}))
vi.mock('./plugin-viewer-guests', () => ({
  getNativePluginViewerCoordinator: () => ({
    create: dependencies.create,
    closeForHost: dependencies.close
  })
}))
import { registerPluginViewerTabHandlers } from './plugin-viewer-tabs'

const frame = {}
const sender = { id: 100, mainFrame: frame }
const event = { sender, senderFrame: frame }
const labels = {
  loading: 'Loading',
  empty: 'Empty',
  previous: 'Previous',
  next: 'Next',
  sheet: 'Sheet',
  reset: 'Reset',
  title: 'Viewer',
  zoomIn: 'In',
  zoomOut: 'Out',
  cachedFormula: 'Saved',
  failed: 'Failed'
}
const request = {
  filePath: '/workspace/file',
  workspaceId: 'folder:one',
  tabId: 'tab:one',
  viewerKey: 'viewer:community.viewer/sample',
  executionHostId: 'local',
  chrome: { dark: true, labels }
}
const id = randomUUID()
const lease = { id, partition: 'private-viewer-slot', url: `orca-plugin-viewer://${id}/` }
beforeEach(() => {
  vi.resetAllMocks()
  dependencies.handlers.clear()
  dependencies.trusted.mockReturnValue(true)
  dependencies.resolveFile.mockResolvedValue('/authorized/opened-file')
  dependencies.bootstrap.mockResolvedValue('<html>Host-owned UI</html>')
  dependencies.create.mockResolvedValue({ ...lease, session: { private: true } })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The mocked resolver receives this opaque store without accessing any members.
  registerPluginViewerTabHandlers({} as Store)
})
describe('trusted renderer viewer tab minting', () => {
  const open = (raw: unknown, actualEvent = event): Promise<unknown> =>
    dependencies.handlers.get('plugins:openViewerTab')!(actualEvent, raw)
  it('authorizes the file and returns only the attach lease', async () => {
    const response = pluginViewerOpenResponseSchema.parse(await open(request))
    expect(response).toEqual({ ok: true, lease })
    expect(dependencies.resolveFile).toHaveBeenCalledWith(request.filePath, undefined, {})
    expect(dependencies.create).toHaveBeenCalledWith({
      host: sender,
      owner: { executionHostId: 'local', workspaceId: request.workspaceId, tabId: request.tabId },
      viewerKey: request.viewerKey,
      bootstrap: '<html>Host-owned UI</html>',
      file: {
        boundaryPath: dirname('/authorized/opened-file'),
        entryPath: '/authorized/opened-file'
      }
    })
  })
  it('denies guest and subframe callers before inspecting a file', async () => {
    dependencies.trusted.mockReturnValueOnce(false)
    expect(await open(request)).toEqual({ ok: false, error: 'unauthorized' })
    expect(await open(request, { sender, senderFrame: {} })).toEqual({
      ok: false,
      error: 'unauthorized'
    })
    expect(dependencies.resolveFile).not.toHaveBeenCalled()
  })
  it('refuses unproved remote hosts without a native filesystem fallback', async () => {
    for (const executionHostId of ['ssh:target', 'runtime:remote']) {
      expect(await open({ ...request, executionHostId })).toEqual({
        ok: false,
        error: executionHostId.startsWith('ssh:') ? 'unsupported_host' : 'unauthorized'
      })
    }
    expect(dependencies.resolveFile).not.toHaveBeenCalled()
    expect(dependencies.create).not.toHaveBeenCalled()
  })
  it('rejects author bootstrap, broad grants and hidden guest state', async () => {
    for (const raw of [
      { ...request, bootstrap: '<script>author()</script>' },
      { ...request, access: { kind: 'document-folder', documentPath: '/' } },
      { ...request, chrome: { ...request.chrome, authorState: {} } }
    ]) {
      expect(await open(raw)).toEqual({ ok: false, error: 'invalid_request' })
    }
    expect(dependencies.resolveFile).not.toHaveBeenCalled()
  })
  it('keeps paths and native failures out of renderer-facing errors', async () => {
    dependencies.resolveFile.mockRejectedValueOnce(new Error('private path /secrets/key'))
    expect(await open(request)).toEqual({ ok: false, error: 'unavailable' })
    expect(dependencies.create).not.toHaveBeenCalled()
  })
  it('checks close authority against the actual sender', async () => {
    await dependencies.handlers.get('plugins:closeViewerTab')!(event, lease)
    expect(dependencies.close).toHaveBeenCalledWith(id, sender.id)
    dependencies.trusted.mockReturnValue(false)
    await dependencies.handlers.get('plugins:closeViewerTab')!(event, lease)
    expect(dependencies.close).toHaveBeenCalledTimes(1)
  })
})
