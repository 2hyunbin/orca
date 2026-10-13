import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginViewerInitializeResponseSchema } from '../../shared/plugins/plugin-viewer-initialize'
import { pluginViewerMetadataSchema } from '../../shared/plugins/plugin-viewer-package'
import { deferred } from '../../shared/plugins/plugin-viewer-document-test-fixture'
import type { PluginViewerFileResource } from '../../shared/plugins/plugin-viewer-file-resource'
import type { PluginViewerFileAuthority } from './plugin-viewer-file-authority'

const transport = vi.hoisted(() => ({
  acquire: vi.fn(),
  active: vi.fn(),
  bound: vi.fn(),
  retire: vi.fn(),
  peers: vi.fn(),
  metrics: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getAppMetrics: transport.metrics },
  webContents: {
    getAllWebContents: transport.peers,
    fromFrame: (frame: { ownerId: number }) =>
      transport.peers().find((item: Contents) => item.id === frame.ownerId)
  }
}))
vi.mock('./plugin-viewer-session-runtime', () => ({
  acquirePluginViewerSession: transport.acquire,
  getActivePluginViewerLease: transport.active,
  isBoundPluginViewerGuest: transport.bound,
  retirePluginViewerSession: transport.retire
}))

import { PluginViewerNativeGuestCoordinator } from './plugin-viewer-native-guest-coordinator'

class Contents extends EventEmitter {
  destroyed = false
  session = {}
  url = ''
  constructor(
    readonly id: number,
    public pid: number
  ) {
    super()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  getOSProcessId(): number {
    return this.pid
  }
  getURL(): string {
    return this.url
  }
  get mainFrame() {
    const frame = {
      ownerId: this.id,
      frameTreeNodeId: this.id,
      processId: this.pid,
      osProcessId: this.pid
    }
    return { ...frame, framesInSubtree: [frame] }
  }
  executeJavaScriptInIsolatedWorld = vi.fn(async () => true)
  copy = vi.fn()
  send = vi.fn()
  forcefullyCrashRenderer = vi.fn(() => this.close())
  close(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

function asContents(fake: Contents): WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fake implements every WebContents member used by the coordinator and watchdog.
  return fake as unknown as WebContents
}

const roots: string[] = []
const coordinators: PluginViewerNativeGuestCoordinator[] = []
afterEach(async () => {
  await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  vi.resetAllMocks()
  const root = await mkdtemp(join(tmpdir(), 'orca-viewer-admission-'))
  roots.push(root)
  const entry = join(root, 'sample.viewer')
  await writeFile(entry, Buffer.from([42, 1, 2, 3]))
  const host = new Contents(1, 100)
  const guest = new Contents(2, 200)
  const viewer = pluginViewerMetadataSchema.parse({
    id: 'sample',
    displayName: 'Sample',
    selector: [{ filenamePattern: '*.viewer' }],
    rendering: 'host-ui',
    mode: 'readonly',
    key: 'viewer:community.viewer/sample',
    pluginKey: 'community.viewer',
    pluginName: 'Sample viewer',
    revision: 'one',
    generation: 1
  })
  const id = randomUUID()
  const lease = {
    id,
    url: `orca-plugin-viewer://${id}/`,
    session: guest.session,
    partition: 'private-test',
    owner: {
      hostWebContentsId: host.id,
      tabId: 'opened-tab',
      pluginKey: viewer.pluginKey,
      pluginGeneration: 1
    }
  }
  guest.url = lease.url
  let live = true
  let bound = true
  let approved = true
  transport.acquire.mockResolvedValue(lease)
  transport.active.mockImplementation((session) =>
    live && session === guest.session ? lease : null
  )
  transport.bound.mockImplementation(
    (candidate, actor) => live && bound && candidate === lease && actor === guest
  )
  transport.retire.mockImplementation(async () => {
    live = false
    guest.close()
  })
  transport.peers.mockReturnValue([host, guest])
  transport.metrics.mockImplementation(() =>
    transport.peers().map((item: Contents) => ({
      pid: item.pid,
      creationTime: item.id,
      type: 'Tab',
      memory: { workingSetSize: 100_000 },
      cpu: { cumulativeCPUUsage: 0 }
    }))
  )
  const viewers = {
    list: vi.fn(() => (approved ? [structuredClone(viewer)] : [])),
    isCurrent: vi.fn(() => approved),
    loadSource: vi.fn(async () => 'orcaViewer.register({open() {}, render() {}})')
  }
  const listeners = new Set<() => void>()
  const whenReady = vi.fn(async () => {})
  const coordinator = new PluginViewerNativeGuestCoordinator({
    viewers,
    whenReady,
    onChanged: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  })
  coordinators.push(coordinator)
  const request = {
    host: asContents(host),
    viewerKey: viewer.key,
    owner: { executionHostId: 'local', workspaceId: 'folder', tabId: 'opened-tab' },
    file: { boundaryPath: root, entryPath: entry },
    bootstrap: '<!doctype html><p>Viewer</p>'
  }
  return {
    coordinator,
    host,
    guest,
    lease,
    request,
    viewers,
    whenReady,
    root,
    revoke: () => {
      approved = false
      for (const listener of listeners) {
        listener()
      }
    },
    setBound: (value: boolean) => {
      bound = value
    }
  }
}

describe('native viewer admission and document authority', () => {
  it('refuses a remote path without a main-owned file authority before creating a guest', async () => {
    const f = await fixture()
    await expect(
      f.coordinator.create({
        ...f.request,
        owner: { ...f.request.owner, executionHostId: 'ssh:target' }
      })
    ).rejects.toMatchObject({ code: 'unsupported_host' })
    expect(transport.acquire).not.toHaveBeenCalled()
    expect(f.viewers.loadSource).not.toHaveBeenCalled()
  })

  it('routes native guest reads to the approved owner’s remote resource and retires on host invalidation', async () => {
    const f = await fixture()
    const resource: PluginViewerFileResource = {
      name: 'remote.bin',
      size: 4,
      read: vi.fn(async () => Buffer.from([9, 8, 7, 6])),
      close: vi.fn(async () => {})
    }
    let invalidate = (): void => {}
    const stop = vi.fn()
    const authority = {
      isCurrent: vi.fn(() => true),
      openFile: vi.fn(async () => resource),
      onInvalidated: (callback: () => void) => {
        invalidate = callback
        return stop
      }
    } satisfies PluginViewerFileAuthority
    await f.coordinator.create({
      ...f.request,
      owner: { ...f.request.owner, executionHostId: 'ssh:target' },
      authority
    })
    const initialized = pluginViewerInitializeResponseSchema.parse(
      await f.coordinator.initialize(asContents(f.guest), true)
    )
    if (!initialized.ok) {
      throw new Error(initialized.error)
    }
    expect(authority.openFile).toHaveBeenCalledWith(f.request.file, expect.any(AbortSignal), {
      executionHostId: 'ssh:target',
      workspaceId: 'folder',
      tabId: 'opened-tab',
      clientId: 'renderer:1',
      pluginKey: 'community.viewer',
      pluginGeneration: 1
    })
    const request = {
      documentHandle: initialized.result.document.documentHandle,
      revision: initialized.result.document.revision,
      position: 0,
      length: 4
    }
    expect(await f.coordinator.read(asContents(f.guest), true, request)).toMatchObject({
      ok: true,
      result: { contentBase64: 'CQgHBg==', bytesRead: 4 }
    })
    invalidate()
    await vi.waitFor(() => expect(resource.close).toHaveBeenCalledOnce())
    expect(f.guest.destroyed).toBe(true)
    expect(stop).toHaveBeenCalledOnce()
    expect(await f.coordinator.read(asContents(f.guest), true, request)).toEqual({
      ok: false,
      error: 'unauthorized'
    })
  })

  it('withholds source and closes a late remote resource when host ownership changes during initialization', async () => {
    const f = await fixture()
    const pending = deferred<PluginViewerFileResource>()
    const resource: PluginViewerFileResource = {
      name: 'remote.bin',
      size: 4,
      read: vi.fn(),
      close: vi.fn(async () => {})
    }
    let invalidate = (): void => {}
    const authority = {
      isCurrent: () => true,
      openFile: vi.fn(() => pending.promise),
      onInvalidated: (callback: () => void) => {
        invalidate = callback
        return () => {}
      }
    }
    await f.coordinator.create({
      ...f.request,
      owner: { ...f.request.owner, executionHostId: 'ssh:target' },
      authority
    })
    const opening = f.coordinator.initialize(asContents(f.guest), true)
    await vi.waitFor(() => expect(authority.openFile).toHaveBeenCalledOnce())
    invalidate()
    pending.resolve(resource)
    expect(await opening).toEqual({ ok: false, error: 'cancelled' })
    await vi.waitFor(() => expect(resource.close).toHaveBeenCalledOnce())
    expect(f.viewers.loadSource).not.toHaveBeenCalled()
  })

  it('checks the live host authority again on a read even before its invalidation event arrives', async () => {
    const f = await fixture()
    const resource: PluginViewerFileResource = {
      name: 'remote.bin',
      size: 4,
      read: vi.fn(),
      close: vi.fn(async () => {})
    }
    const authority = {
      isCurrent: vi.fn(() => true),
      openFile: vi.fn(async () => resource),
      onInvalidated: () => () => {}
    }
    await f.coordinator.create({
      ...f.request,
      owner: { ...f.request.owner, executionHostId: 'ssh:target' },
      authority
    })
    const initialized = pluginViewerInitializeResponseSchema.parse(
      await f.coordinator.initialize(asContents(f.guest), true)
    )
    if (!initialized.ok) {
      throw new Error(initialized.error)
    }
    authority.isCurrent.mockReturnValue(false)
    expect(
      await f.coordinator.read(asContents(f.guest), true, {
        documentHandle: initialized.result.document.documentHandle,
        revision: initialized.result.document.revision,
        position: 0,
        length: 4
      })
    ).toEqual({ ok: false, error: 'unauthorized' })
    expect(resource.read).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(resource.close).toHaveBeenCalledOnce())
  })

  it('cleans up a guest when its host invalidation observer throws or invalidates synchronously', async () => {
    for (const immediate of [true, false]) {
      const f = await fixture()
      const stop = vi.fn()
      const authority = {
        isCurrent: () => true,
        openFile: vi.fn(),
        onInvalidated: (callback: () => void) => {
          if (!immediate) {
            throw new Error('Observer unavailable')
          }
          callback()
          return stop
        }
      }
      await expect(
        f.coordinator.create({
          ...f.request,
          owner: { ...f.request.owner, executionHostId: 'ssh:target' },
          authority
        })
      ).rejects.toThrow()
      expect(f.guest.destroyed).toBe(true)
      expect(authority.openFile).not.toHaveBeenCalled()
      if (immediate) {
        expect(stop).toHaveBeenCalledOnce()
      }
    }
  })

  it('withholds approved source when complete process accounting is unavailable', async () => {
    const f = await fixture()
    await f.coordinator.create(f.request)
    transport.metrics.mockReturnValue([])
    expect(await f.coordinator.initialize(asContents(f.guest), true)).toEqual({
      ok: false,
      error: 'unavailable'
    })
    expect(f.viewers.loadSource).not.toHaveBeenCalled()
    expect(f.guest.destroyed).toBe(true)
    expect(f.host.send).toHaveBeenCalledExactlyOnceWith('plugins:viewerUnavailable', {
      leaseId: f.lease.id,
      code: 'unavailable'
    })
  })
  it('copies only the initialized bound guest selection and refuses extra clipboard authority', async () => {
    const f = await fixture()
    await f.coordinator.create(f.request)
    expect(f.coordinator.copySelection(asContents(f.guest), true)).toBe(false)
    await f.coordinator.initialize(asContents(f.guest), true)
    expect(f.coordinator.copySelection(asContents(f.host), true)).toBe(false)
    expect(f.coordinator.copySelection(asContents(f.guest), false)).toBe(false)
    f.setBound(false)
    expect(f.coordinator.copySelection(asContents(f.guest), true)).toBe(false)
    f.setBound(true)
    expect(f.coordinator.copySelection(asContents(f.guest), true)).toBe(true)
    expect(f.guest.copy).toHaveBeenCalledExactlyOnceWith()
    expect(f.coordinator.copySelection(asContents(f.guest), true)).toBe(false)
    f.revoke()
    expect(f.coordinator.copySelection(asContents(f.guest), true)).toBe(false)
    expect(f.guest.copy).toHaveBeenCalledOnce()
    expect(f.host.copy).not.toHaveBeenCalled()
  })
  it.each(['revision', 'pid', 'shared-process'] as const)(
    'refuses copying after %s authority changes',
    async (change) => {
      const f = await fixture()
      await f.coordinator.create(f.request)
      await f.coordinator.initialize(asContents(f.guest), true)
      if (change === 'revision') {
        f.viewers.isCurrent.mockReturnValue(false)
      }
      if (change === 'pid') {
        f.guest.pid++
      }
      if (change === 'shared-process') {
        transport.peers.mockReturnValue([f.host, f.guest, new Contents(3, f.guest.pid)])
      }
      expect(f.coordinator.copySelection(asContents(f.guest), true)).toBe(false)
      expect(f.guest.copy).not.toHaveBeenCalled()
    }
  )
  it('retires coordinator ownership on main-document navigation and permits reopening', async () => {
    const f = await fixture()
    await f.coordinator.create(f.request)
    f.host.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    f.host.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(transport.retire).not.toHaveBeenCalled()
    f.host.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await vi.waitFor(() => expect(transport.retire).toHaveBeenCalledWith(f.lease.id))
    expect(f.host.listenerCount('did-start-navigation')).toBe(0)
    await expect(f.coordinator.create(f.request)).resolves.toBe(f.lease)
  })
  it('cancels a pending mint when its caller navigates before registry readiness', async () => {
    const f = await fixture()
    const readiness = deferred<void>()
    f.whenReady.mockImplementationOnce(() => readiness.promise)
    const creating = f.coordinator.create(f.request)
    f.host.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    readiness.resolve()
    await expect(creating).rejects.toThrow('cancelled')
    expect(transport.acquire).not.toHaveBeenCalled()
    expect(f.host.listenerCount('did-start-navigation')).toBe(0)
  })
  it('only lets the actual owner close a live tab lease', async () => {
    const f = await fixture()
    await f.coordinator.create(f.request)
    await f.coordinator.closeForHost(f.lease.id, f.host.id + 1)
    expect(transport.retire).not.toHaveBeenCalled()
    await f.coordinator.closeForHost(f.lease.id, f.host.id)
    expect(transport.retire).toHaveBeenCalledWith(f.lease.id)
  })
  it('admits a reviewed source only to the bound guest and reads the actual opened binary file', async () => {
    const f = await fixture()
    await f.coordinator.create(f.request)
    expect(await f.coordinator.initialize(asContents(f.host), true)).toEqual({
      ok: false,
      error: 'unauthorized'
    })
    expect(await f.coordinator.initialize(asContents(f.guest), false)).toEqual({
      ok: false,
      error: 'unauthorized'
    })
    const initialized = await f.coordinator.initialize(asContents(f.guest), true)
    expect(pluginViewerInitializeResponseSchema.safeParse(initialized).success).toBe(true)
    expect(initialized.ok).toBe(true)
    if (!initialized.ok) {
      throw new Error('viewer not initialized')
    }
    expect(JSON.stringify(initialized)).not.toContain(f.root)
    const request = {
      documentHandle: initialized.result.document.documentHandle,
      revision: initialized.result.document.revision,
      position: 0,
      length: 4
    }
    expect(await f.coordinator.read(asContents(f.guest), true, request)).toMatchObject({
      ok: true,
      result: { contentBase64: 'KgECAw==', bytesRead: 4, eof: true }
    })
    expect(await f.coordinator.read(asContents(f.host), true, request)).toEqual({
      ok: false,
      error: 'unauthorized'
    })
    expect(await f.coordinator.read(asContents(f.guest), false, request)).toEqual({
      ok: false,
      error: 'unauthorized'
    })
  })

  it('does not load author source for an unbound or shared-process guest', async () => {
    const f = await fixture()
    await f.coordinator.create(f.request)
    f.setBound(false)
    expect(await f.coordinator.initialize(asContents(f.guest), true)).toEqual({
      ok: false,
      error: 'unauthorized'
    })
    f.setBound(true)
    f.guest.pid = f.host.pid
    expect(await f.coordinator.initialize(asContents(f.guest), true)).toEqual({
      ok: false,
      error: 'unauthorized'
    })
    expect(f.viewers.loadSource).not.toHaveBeenCalled()
    expect(f.host.destroyed).toBe(false)
  })

  it('withholds reads and repeat initialization until source verification finishes', async () => {
    const f = await fixture()
    const source = deferred<string>()
    f.viewers.loadSource.mockImplementationOnce(() => source.promise)
    await f.coordinator.create(f.request)
    const initialization = f.coordinator.initialize(asContents(f.guest), true)
    await vi.waitFor(() => expect(f.viewers.loadSource).toHaveBeenCalledOnce())
    expect(await f.coordinator.read(asContents(f.guest), true, {})).toEqual({
      ok: false,
      error: 'unauthorized'
    })
    expect(await f.coordinator.initialize(asContents(f.guest), true)).toEqual({
      ok: false,
      error: 'unavailable'
    })
    source.resolve('orcaViewer.register({open() {}, render() {}})')
    expect((await initialization).ok).toBe(true)
  })

  it('discards source arriving after approval is withdrawn and closes the isolated guest', async () => {
    const f = await fixture()
    const source = deferred<string>()
    f.viewers.loadSource.mockImplementationOnce(() => source.promise)
    await f.coordinator.create(f.request)
    const initialization = f.coordinator.initialize(asContents(f.guest), true)
    await vi.waitFor(() => expect(f.viewers.loadSource).toHaveBeenCalledOnce())
    f.revoke()
    source.resolve('must not reach the guest')
    expect(await initialization).toEqual({ ok: false, error: 'unauthorized' })
    expect(f.guest.destroyed).toBe(true)
  })

  it('awaits a benign registry refresh rather than withdrawing unchanged approval', async () => {
    const f = await fixture()
    await f.coordinator.create(f.request)
    const initialized = await f.coordinator.initialize(asContents(f.guest), true)
    if (!initialized.ok) {
      throw new Error('viewer not initialized')
    }
    const ready = deferred<void>()
    f.whenReady.mockImplementation(() => ready.promise)
    f.viewers.isCurrent.mockReturnValue(false)
    const reading = f.coordinator.read(asContents(f.guest), true, {
      documentHandle: initialized.result.document.documentHandle,
      revision: initialized.result.document.revision,
      position: 0,
      length: 1
    })
    f.viewers.isCurrent.mockReturnValue(true)
    ready.resolve()
    expect(await reading).toMatchObject({ ok: true, result: { contentBase64: 'Kg==' } })
    expect(f.guest.destroyed).toBe(false)
  })

  it('rejects reads after the captured renderer process changes', async () => {
    const f = await fixture()
    await f.coordinator.create(f.request)
    const initialized = await f.coordinator.initialize(asContents(f.guest), true)
    if (!initialized.ok) {
      throw new Error('viewer not initialized')
    }
    f.guest.pid++
    expect(
      await f.coordinator.read(asContents(f.guest), true, {
        documentHandle: initialized.result.document.documentHandle,
        revision: initialized.result.document.revision,
        position: 0,
        length: 1
      })
    ).toEqual({ ok: false, error: 'unauthorized' })
    expect(f.guest.destroyed).toBe(true)
    expect(f.host.destroyed).toBe(false)
  })

  it('keeps source-loader paths and internal errors out of guest-facing failures', async () => {
    const f = await fixture()
    f.viewers.loadSource.mockRejectedValueOnce(new Error(`private source: ${f.root}`))
    await f.coordinator.create(f.request)
    expect(await f.coordinator.initialize(asContents(f.guest), true)).toEqual({
      ok: false,
      error: 'unavailable'
    })
    expect(f.guest.destroyed).toBe(true)
  })

  it('cancels a lease prepared after its owning host closes', async () => {
    const f = await fixture()
    const preparation = deferred<typeof f.lease>()
    transport.acquire.mockImplementationOnce(() => preparation.promise)
    const creating = f.coordinator.create(f.request)
    await vi.waitFor(() => expect(transport.acquire).toHaveBeenCalledOnce())
    f.host.close()
    preparation.resolve(f.lease)
    await expect(creating).rejects.toThrow('cancelled')
    expect(transport.retire).toHaveBeenCalledWith(f.lease.id)
  })
})
