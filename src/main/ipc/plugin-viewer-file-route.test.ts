import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../persistence'
import { pluginViewerOpenRequestSchema } from '../../shared/plugins/plugin-viewer-open'
import { resolvePluginViewerFileRoute } from './plugin-viewer-file-route'

const routes = vi.hoisted(() => ({ local: vi.fn(), runtime: vi.fn() }))
vi.mock('./local-file-access-resolution', () => ({ resolveLocalFileRequestPath: routes.local }))
vi.mock('./plugin-viewer-runtime-file-route', () => ({
  resolvePluginViewerRuntimeFileRoute: routes.runtime
}))
let root: string
let store: Store
beforeEach(async () => {
  vi.resetAllMocks()
  root = await mkdtemp(join(tmpdir(), 'orca-viewer-route-'))
  store = new Store({ dataFile: join(root, 'orca-data.json'), serializedState: '{}' })
  routes.local.mockResolvedValue(join(root, 'sample.bin'))
  routes.runtime.mockResolvedValue({
    file: { boundaryPath: '/remote', entryPath: '/remote/sample.bin' }
  })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
function request(host = 'local') {
  return pluginViewerOpenRequestSchema.parse({
    filePath: '/remote/sample.bin',
    workspaceId: 'folder:one',
    tabId: 'tab:one',
    viewerKey: 'viewer:community.viewer/sample',
    executionHostId: host,
    chrome: {
      dark: true,
      labels: {
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
    }
  })
}

describe('native viewer routing to the filesystem owner', () => {
  it('uses the existing local authorizer for a local path and derives its file boundary', async () => {
    const input = request()
    const resolved = await resolvePluginViewerFileRoute(store, input)
    expect(resolved.file).toEqual({ boundaryPath: root, entryPath: join(root, 'sample.bin') })
    expect(routes.local).toHaveBeenCalledWith(input.filePath, undefined, store)
    expect(routes.runtime).not.toHaveBeenCalled()
  })
  it('preserves explicit local selected-file authority', async () => {
    const input = { ...request(), access: { kind: 'user-file' } as const }
    await resolvePluginViewerFileRoute(store, input)
    expect(routes.local).toHaveBeenCalledWith(input.filePath, input.access, store)
  })
  it.each([
    { expectedSshConnectionGeneration: 0 },
    { expectedEnvironmentPairingRevision: 1 },
    { expectedEnvironmentRuntimeId: 'runtime-one' }
  ])('rejects remote provenance on a local route: %j', async (provenance) => {
    await expect(
      resolvePluginViewerFileRoute(store, { ...request(), ...provenance })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(routes.local).not.toHaveBeenCalled()
    expect(routes.runtime).not.toHaveBeenCalled()
  })
  it('delegates managed-host provenance to the existing paired runtime authority', async () => {
    const input = {
      ...request('runtime:managed-host'),
      expectedEnvironmentPairingRevision: 1,
      expectedEnvironmentRuntimeId: 'runtime-one'
    }
    expect(await resolvePluginViewerFileRoute(store, input, root)).toEqual(
      await routes.runtime.mock.results[0]?.value
    )
    expect(routes.runtime).toHaveBeenCalledWith(root, input)
    expect(routes.local).not.toHaveBeenCalled()
  })
  it('does not route a remote request without its host environment store', async () => {
    await expect(
      resolvePluginViewerFileRoute(store, request('runtime:managed-host'))
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(routes.runtime).not.toHaveBeenCalled()
    expect(routes.local).not.toHaveBeenCalled()
  })
  it.each(['ssh:target', 'ssh:nested-target'])(
    'refuses retired SSH paths without accessing desktop bytes: %s',
    async (host) => {
      await expect(
        resolvePluginViewerFileRoute(
          store,
          { ...request(host), expectedSshConnectionGeneration: 0 },
          root
        )
      ).rejects.toMatchObject({ code: 'unsupported_host' })
      expect(routes.local).not.toHaveBeenCalled()
      expect(routes.runtime).not.toHaveBeenCalled()
    }
  )
  it.each(['invalid', 'local ', 'ssh:', 'runtime:'])(
    'refuses malformed host identity: %s',
    async (host) => {
      await expect(resolvePluginViewerFileRoute(store, request(host), root)).rejects.toMatchObject({
        code: 'unauthorized'
      })
      expect(routes.local).not.toHaveBeenCalled()
      expect(routes.runtime).not.toHaveBeenCalled()
    }
  )
  it('copies caller data before an asynchronous remote route is resolved', async () => {
    const input = request('runtime:managed-host')
    const pending = resolvePluginViewerFileRoute(store, input, root)
    input.filePath = '/foreign/changed.bin'
    input.executionHostId = 'local'
    await pending
    expect(routes.runtime.mock.calls[0]?.[1]).toMatchObject({
      executionHostId: 'runtime:managed-host',
      filePath: '/remote/sample.bin'
    })
  })
})
