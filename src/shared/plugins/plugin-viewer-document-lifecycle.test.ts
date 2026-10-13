import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PluginViewerDocumentRegistry,
  type PluginViewerDocumentOwner
} from './plugin-viewer-document-registry'
import {
  createViewerDocumentFixture,
  deferred,
  delayedViewerRegistry,
  viewerOwner
} from './plugin-viewer-document-test-fixture'
import { openPluginViewerFileResource } from './plugin-viewer-file-resource'
import type { PluginViewerDocumentInfo } from './plugin-viewer-document'

const roots: string[] = []
const registries: PluginViewerDocumentRegistry[] = []

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const result = await createViewerDocumentFixture(roots, Buffer.from([0, 255, 1]))
  registries.push(result.registry)
  return result
}

describe('viewer document lifetime and quotas', () => {
  it('bounds per-session and global concurrent reads while control can still revoke', async () => {
    const setup = await fixture()
    const delayed = delayedViewerRegistry()
    registries.push(delayed.registry)
    const secondOwner = { ...viewerOwner, tabId: 'second-tab' }
    const thirdOwner = { ...viewerOwner, tabId: 'third-tab' }
    const first = await delayed.registry.create(viewerOwner, setup.file)
    const second = await delayed.registry.create(secondOwner, setup.file)
    const third = await delayed.registry.create(thirdOwner, setup.file)
    const request = (info: typeof first) => ({
      documentHandle: info.documentHandle,
      revision: info.revision,
      position: 0,
      length: 1
    })
    const pending = [
      delayed.registry.read(viewerOwner, request(first)),
      delayed.registry.read(viewerOwner, request(first)),
      delayed.registry.read(secondOwner, request(second)),
      delayed.registry.read(secondOwner, request(second))
    ]
    await vi.waitFor(() => expect(delayed.readStarted).toHaveBeenCalledTimes(4))
    expect(await delayed.registry.read(viewerOwner, request(first))).toEqual({
      ok: false,
      error: 'limit_exceeded'
    })
    expect(await delayed.registry.read(thirdOwner, request(third))).toEqual({
      ok: false,
      error: 'limit_exceeded'
    })
    delayed.registry.revoke(() => true)
    delayed.gate.resolve()
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 4 }, () => ({ ok: false, error: 'cancelled' }))
    )
  })

  it('caps live documents and releases their slots on close', async () => {
    const setup = await fixture()
    const infos: PluginViewerDocumentInfo[] = []
    for (let index = 0; index < 8; index++) {
      infos.push(await setup.registry.create(viewerOwner, setup.file))
    }
    await expect(setup.registry.create(viewerOwner, setup.file)).rejects.toMatchObject({
      code: 'limit_exceeded'
    })
    setup.registry.close(viewerOwner, infos[0].documentHandle)
    expect((await setup.registry.create(viewerOwner, setup.file)).size).toBe(3)
  })

  it('reserves opening slots before awaiting authority and cancels them on disconnect', async () => {
    const setup = await fixture()
    const authority = deferred<boolean>()
    const openFile = vi.fn(openPluginViewerFileResource)
    const registry = new PluginViewerDocumentRegistry({
      isAuthorized: () => authority.promise,
      onCloseError: vi.fn(),
      openFile
    })
    registries.push(registry)
    const pending = [
      registry.create(viewerOwner, setup.file),
      registry.create(viewerOwner, setup.file)
    ]
    const settled = Promise.allSettled(pending)
    await expect(registry.create(viewerOwner, setup.file)).rejects.toMatchObject({
      code: 'limit_exceeded'
    })
    await registry.dispose()
    for (const result of await settled) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'cancelled' })
      }
    }
    authority.reject(new Error('private transport address'))
    expect(openFile).not.toHaveBeenCalled()
    await expect(registry.create(viewerOwner, setup.file)).rejects.toMatchObject({
      code: 'unavailable'
    })
  })

  it('closes a handle opened after its owner was revoked and waits for cleanup', async () => {
    const setup = await fixture()
    const gate = deferred<void>()
    const started = deferred<void>()
    const closed = vi.fn()
    const registry = new PluginViewerDocumentRegistry({
      isAuthorized: () => true,
      onCloseError: vi.fn(),
      async openFile(request, signal) {
        const resource = await openPluginViewerFileResource(request, signal)
        started.resolve()
        await gate.promise
        return {
          ...resource,
          async close() {
            closed()
            await resource.close()
          }
        }
      }
    })
    registries.push(registry)
    const pending = registry.create(viewerOwner, setup.file)
    const settled = pending.catch((error: unknown) => error)
    await started.promise
    const disposed = registry.dispose()
    gate.resolve()
    expect(await settled).toMatchObject({ code: 'cancelled' })
    await disposed
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('rechecks approval after I/O rather than returning bytes to a revoked plugin', async () => {
    const setup = await fixture()
    let checks = 0
    const registry = new PluginViewerDocumentRegistry({
      isAuthorized: () => ++checks < 4,
      onCloseError: vi.fn()
    })
    registries.push(registry)
    const info = await registry.create(viewerOwner, setup.file)
    expect(
      await registry.read(viewerOwner, {
        documentHandle: info.documentHandle,
        revision: info.revision,
        position: 0,
        length: 1
      })
    ).toEqual({ ok: false, error: 'unauthorized' })
  })

  it('snapshots trusted owners and file requests before asynchronous checks', async () => {
    const setup = await fixture()
    const gate = deferred<boolean>()
    const seen: PluginViewerDocumentOwner[] = []
    const registry = new PluginViewerDocumentRegistry({
      isAuthorized(owner) {
        seen.push(owner)
        return gate.promise
      },
      onCloseError: vi.fn()
    })
    registries.push(registry)
    const mutableOwner = { ...viewerOwner }
    const mutableFile = { ...setup.file }
    const pending = registry.create(mutableOwner, mutableFile)
    mutableOwner.tabId = 'later-tab'
    mutableFile.entryPath = setup.root
    gate.resolve(true)
    const info = await pending
    expect(info.name).toBe('workbook.xlsx')
    expect(seen.every((owner) => owner.tabId === viewerOwner.tabId)).toBe(true)
    info.size = 0
    expect(
      await registry.read(viewerOwner, {
        documentHandle: info.documentHandle,
        revision: info.revision,
        position: 0,
        length: 1
      })
    ).toMatchObject({ ok: true, result: { bytesRead: 1, eof: false } })
  })

  it('sanitizes open/read failures and reports cleanup errors without host paths', async () => {
    const setup = await fixture()
    const onCloseError = vi.fn()
    const registry = new PluginViewerDocumentRegistry({
      isAuthorized: () => true,
      onCloseError,
      async openFile() {
        return {
          name: 'model.stl',
          size: 3,
          async read() {
            throw new Error('/private/host/path')
          },
          async close() {
            throw new Error('/private/host/path')
          }
        }
      }
    })
    registries.push(registry)
    const info = await registry.create(viewerOwner, setup.file)
    const response = await registry.read(viewerOwner, {
      documentHandle: info.documentHandle,
      revision: info.revision,
      position: 0,
      length: 1
    })
    expect(response).toEqual({ ok: false, error: 'read_failed' })
    await registry.dispose()
    expect(onCloseError).toHaveBeenCalledTimes(1)
    const broken = new PluginViewerDocumentRegistry({
      isAuthorized: () => true,
      onCloseError: vi.fn(),
      async openFile() {
        throw new Error('/private/host/path')
      }
    })
    registries.push(broken)
    await expect(broken.create(viewerOwner, setup.file)).rejects.toMatchObject({
      code: 'read_failed'
    })
  })
})
