import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodePairingOffer } from '../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  markEnvironmentUsed,
  resolveEnvironment,
  updateEnvironmentFromPairingCode
} from '../../shared/runtime-environment-store'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import { pluginViewerOpenRequestSchema } from '../../shared/plugins/plugin-viewer-open'
import { runtimeViewerRpcFixture } from '../runtime/runtime-plugin-viewer-rpc-test-fixture'
import { advanceRuntimeEnvironmentTransportGeneration } from './runtime-environment-transport-generation'

vi.mock('./runtime-environment-managed-tunnel', () => ({
  resolveManagedRuntimeEnvironment: async (root: string, id: string) => resolveEnvironment(root, id)
}))
import { resolvePluginViewerRuntimeFileRoute } from './plugin-viewer-runtime-file-route'
import { resolvePluginViewerFileRoute } from './plugin-viewer-file-route'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

async function fixture(folder = false) {
  const f = await runtimeViewerRpcFixture(cleanups, 'runtime', folder)
  const clientRoot = await realpath(await mkdtemp(join(tmpdir(), 'orca-viewer-client-')))
  cleanups.push(() => rm(clientRoot, { recursive: true, force: true }))
  const environment = addEnvironmentFromPairingCode(clientRoot, {
    name: 'viewer-host',
    pairingCode: encodePairingOffer(f.pairing),
    now: 1
  })
  markEnvironmentUsed(clientRoot, environment.id, { runtimeId: f.input.runtimeId })
  const request = pluginViewerOpenRequestSchema.parse({
    filePath: f.filePath,
    workspaceId: f.input.owner.workspaceId,
    tabId: f.input.owner.tabId,
    viewerKey: 'viewer:publisher.viewer/binary',
    executionHostId: toRuntimeExecutionHostId(environment.id),
    expectedEnvironmentPairingRevision: 1,
    expectedEnvironmentRuntimeId: f.input.runtimeId,
    chrome: {
      dark: true,
      labels: Object.fromEntries(
        [
          'loading',
          'empty',
          'previous',
          'next',
          'sheet',
          'reset',
          'title',
          'zoomIn',
          'zoomOut',
          'cachedFormula',
          'failed'
        ].map((key) => [key, key])
      )
    }
  })
  const owner = { ...f.input.owner, executionHostId: request.executionHostId }
  return { ...f, root: clientRoot, hostRoot: f.root, request, owner, environment }
}

describe('desktop runtime viewer file authority with real paired Store and E2EE leases', () => {
  it.each([false, true])(
    'uses the actual native entry for remote binary bytes; folder=%s',
    async (folder) => {
      const f = await fixture(folder)
      expect(f.root).not.toBe(f.hostRoot)
      const route = await resolvePluginViewerFileRoute(f.store, f.request, f.root)
      if (!route.authority) {
        throw new Error('remote route has no host authority')
      }
      cleanups.push(route.authority.onInvalidated(vi.fn()))
      const resource = await route.authority.openFile(
        route.file,
        new AbortController().signal,
        f.owner
      )
      cleanups.push(() => resource.close())
      expect(await resource.read(0, 4, new AbortController().signal)).toEqual(
        Buffer.from([0, 128, 255, 42])
      )
    }
  )
  it.each([false, true])(
    'routes actual binary ranges and retires its exact environment; folder=%s',
    async (folder) => {
      const f = await fixture(folder)
      const route = await resolvePluginViewerRuntimeFileRoute(f.root, f.request)
      const invalidated = vi.fn()
      const stop = route.authority.onInvalidated(invalidated)
      cleanups.push(stop)
      const file = await route.authority.openFile(route.file, new AbortController().signal, f.owner)
      cleanups.push(() => file.close())
      expect(await file.read(1, 2, new AbortController().signal)).toEqual(Buffer.from([128, 255]))
      advanceRuntimeEnvironmentTransportGeneration('unrelated-viewer-host')
      expect(route.authority.isCurrent()).toBe(true)
      expect(invalidated).not.toHaveBeenCalled()
      advanceRuntimeEnvironmentTransportGeneration(f.environment.id)
      expect(route.authority.isCurrent()).toBe(false)
      expect(invalidated).toHaveBeenCalledTimes(1)
      await expect(file.read(0, 1, new AbortController().signal)).rejects.toMatchObject({
        code: 'cancelled'
      })
    }
  )

  it('rejects missing, stale and cross-transport provenance before a host document opens', async () => {
    const f = await fixture()
    const open = vi.spyOn(f.runtime, 'openRuntimePluginViewerDocument')
    for (const change of [
      { expectedEnvironmentPairingRevision: undefined },
      { expectedEnvironmentPairingRevision: 0 },
      { expectedEnvironmentRuntimeId: undefined },
      { expectedEnvironmentRuntimeId: 'wrong-runtime' },
      { expectedSshConnectionGeneration: 0 },
      { filePath: 'relative.bin' }
    ]) {
      await expect(
        resolvePluginViewerRuntimeFileRoute(f.root, { ...f.request, ...change })
      ).rejects.toMatchObject({ code: 'unauthorized' })
    }
    expect(open).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'obtains a one-file host grant for an explicitly named outside runtime file; folder=%s',
    async (folder) => {
      const f = await fixture(folder)
      const filePath = join(f.hostRoot, 'named.fixture')
      await writeFile(filePath, Buffer.from([42, 128, 255]))
      const select = vi.spyOn(f.runtime, 'selectRuntimePluginViewerFile')
      const route = await resolvePluginViewerRuntimeFileRoute(f.root, {
        ...f.request,
        filePath,
        access: { kind: 'user-file' }
      })
      cleanups.push(route.authority.onInvalidated(vi.fn()))
      const file = await route.authority.openFile(route.file, new AbortController().signal, f.owner)
      cleanups.push(() => file.close())
      expect(await file.read(0, 3, new AbortController().signal)).toEqual(
        Buffer.from([42, 128, 255])
      )
      expect(select).toHaveBeenCalledTimes(1)
      const [input, transport] = select.mock.calls[0] ?? []
      expect(input).toMatchObject({ filePath, owner: f.owner })
      expect(transport?.connectionId).toBeTruthy()
      expect(transport?.clientId).toBeTruthy()
      advanceRuntimeEnvironmentTransportGeneration(f.environment.id)
      await expect(file.read(0, 1, new AbortController().signal)).rejects.toMatchObject({
        code: 'cancelled'
      })
    }
  )

  it('checks exact file and owner fields and still relies on the actual host catalog', async () => {
    const f = await fixture()
    const route = await resolvePluginViewerRuntimeFileRoute(f.root, f.request)
    const stop = route.authority.onInvalidated(vi.fn())
    cleanups.push(stop)
    await expect(
      route.authority.openFile(
        { ...route.file, boundaryPath: '/' },
        new AbortController().signal,
        f.owner
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(
      route.authority.openFile(route.file, new AbortController().signal, {
        ...f.owner,
        workspaceId: 'unknown-workspace'
      })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    const foreign = await resolvePluginViewerRuntimeFileRoute(f.root, {
      ...f.request,
      workspaceId: 'unknown-workspace'
    })
    const stopForeign = foreign.authority.onInvalidated(vi.fn())
    cleanups.push(stopForeign)
    await expect(
      foreign.authority.openFile(foreign.file, new AbortController().signal, {
        ...f.owner,
        workspaceId: 'unknown-workspace'
      })
    ).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('refuses a saved pairing rotation and releases the old resource without borrowing new credentials', async () => {
    const f = await fixture()
    const route = await resolvePluginViewerRuntimeFileRoute(f.root, f.request)
    cleanups.push(route.authority.onInvalidated(vi.fn()))
    const file = await route.authority.openFile(route.file, new AbortController().signal, f.owner)
    cleanups.push(() => file.close())
    updateEnvironmentFromPairingCode(f.root, f.environment.id, {
      pairingCode: encodePairingOffer(f.pairing),
      now: 2
    })
    expect(route.authority.isCurrent()).toBe(false)
    await expect(resolvePluginViewerRuntimeFileRoute(f.root, f.request)).rejects.toMatchObject({
      code: 'unauthorized'
    })
  })
})
