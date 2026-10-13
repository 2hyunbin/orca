import { randomUUID } from 'node:crypto'
import { rename, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PLUGIN_VIEWER_CHUNK_BYTES,
  PLUGIN_VIEWER_DOCUMENT_BYTES,
  PLUGIN_VIEWER_TRANSFER_BYTES,
  pluginViewerReadResponseSchema
} from './plugin-viewer-document'
import type { PluginViewerDocumentRegistry } from './plugin-viewer-document-registry'
import {
  createViewerDocumentFixture,
  delayedViewerRegistry,
  viewerOwner
} from './plugin-viewer-document-test-fixture'

const roots: string[] = []
const registries: PluginViewerDocumentRegistry[] = []

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(bytes = Buffer.from([0, 255, 1, 0, 200])) {
  const result = await createViewerDocumentFixture(roots, bytes)
  registries.push(result.registry)
  return result
}

describe('host-authorized viewer documents', () => {
  it('reads arbitrary binary formats by position without exposing a path', async () => {
    const setup = await fixture()
    const info = await setup.registry.create(viewerOwner, setup.file)
    expect(info).toMatchObject({
      name: 'workbook.xlsx',
      size: 5,
      features: { rangeRead: true, watch: false }
    })
    expect(JSON.stringify(info)).not.toContain(setup.workspace)
    const response = await setup.registry.read(viewerOwner, {
      documentHandle: info.documentHandle,
      revision: info.revision,
      position: 1,
      length: 3
    })
    expect(response).toEqual({
      ok: true,
      result: {
        revision: info.revision,
        bytesRead: 3,
        contentBase64: Buffer.from([255, 1, 0]).toString('base64'),
        eof: false
      }
    })
    expect(pluginViewerReadResponseSchema.safeParse(response).success).toBe(true)
    expect(
      await setup.registry.read(viewerOwner, {
        documentHandle: info.documentHandle,
        revision: info.revision,
        position: 5,
        length: 1
      })
    ).toMatchObject({ ok: true, result: { bytesRead: 0, contentBase64: '', eof: true } })
  })

  it.each([
    { executionHostId: 'ssh-host' },
    { workspaceId: 'another-folder' },
    { clientId: 'another-client' },
    { tabId: 'another-tab' },
    { pluginKey: 'other-publisher/workbook' },
    { pluginGeneration: 2 }
  ])('binds even a known handle to every owner dimension: %j', async (change) => {
    const setup = await fixture()
    const info = await setup.registry.create(viewerOwner, setup.file)
    const other = { ...viewerOwner, ...change }
    setup.registry.close(other, info.documentHandle)
    const request = { ...info, position: 0, length: 1 }
    const { name: _name, size: _size, features: _features, ...wireRequest } = request
    expect(await setup.registry.read(other, wireRequest)).toEqual({
      ok: false,
      error: 'unauthorized'
    })
    expect((await setup.registry.read(viewerOwner, wireRequest)).ok).toBe(true)
  })

  it('rejects malformed requests before reading and never grants a sibling', async () => {
    const setup = await fixture()
    const info = await setup.registry.create(viewerOwner, setup.file)
    expect(
      await setup.registry.read(viewerOwner, {
        documentHandle: info.documentHandle,
        revision: info.revision,
        position: 0,
        length: 1,
        path: join(setup.workspace, 'sibling')
      })
    ).toEqual({ ok: false, error: 'invalid_request' })
    expect(
      await setup.registry.read(viewerOwner, {
        documentHandle: info.documentHandle,
        revision: randomUUID(),
        position: 0,
        length: 1
      })
    ).toEqual({ ok: false, error: 'stale_revision' })
    expect(setup.isAuthorized).toHaveBeenCalledTimes(2)
  })

  it('refuses outside files, directories and symlink escapes', async () => {
    const setup = await fixture()
    const outside = join(setup.root, 'secret')
    await writeFile(outside, 'secret')
    await expect(
      setup.registry.create(viewerOwner, { ...setup.file, entryPath: outside })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(
      setup.registry.create(viewerOwner, { ...setup.file, entryPath: setup.workspace })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await rm(setup.entry)
    await symlink(outside, setup.entry)
    await expect(setup.registry.create(viewerOwner, setup.file)).rejects.toMatchObject({
      code: 'unauthorized'
    })
  })

  it('rejects oversized inputs before allocating document bytes', async () => {
    const setup = await fixture()
    await truncate(setup.entry, PLUGIN_VIEWER_DOCUMENT_BYTES + 1)
    await expect(setup.registry.create(viewerOwner, setup.file)).rejects.toMatchObject({
      code: 'limit_exceeded'
    })
    await truncate(setup.entry, 0)
    const info = await setup.registry.create(viewerOwner, setup.file)
    expect(info.size).toBe(0)
  })

  it.each(['replace', 'rewrite', 'retarget'] as const)(
    'invalidates rather than mixing bytes after %s',
    async (change) => {
      const setup = await fixture()
      const info = await setup.registry.create(viewerOwner, setup.file)
      if (change === 'replace') {
        const candidate = join(setup.workspace, 'replacement')
        await writeFile(candidate, 'other')
        await rename(candidate, setup.entry)
      } else if (change === 'rewrite') {
        await writeFile(setup.entry, 'other')
        await utimes(setup.entry, new Date(0), new Date(0))
      } else {
        const outside = join(setup.root, 'secret')
        await writeFile(outside, 'secret')
        await rm(setup.entry)
        await symlink(outside, setup.entry)
      }
      const request = {
        documentHandle: info.documentHandle,
        revision: info.revision,
        position: 0,
        length: 5
      }
      expect(await setup.registry.read(viewerOwner, request)).toEqual({
        ok: false,
        error: 'stale_revision'
      })
      expect(await setup.registry.read(viewerOwner, request)).toEqual({
        ok: false,
        error: 'unauthorized'
      })
    }
  )

  it('withdraws file authority when approval disappears without an explicit close', async () => {
    const setup = await fixture()
    const info = await setup.registry.create(viewerOwner, setup.file)
    setup.isAuthorized.mockReturnValue(false)
    expect(
      await setup.registry.read(viewerOwner, {
        documentHandle: info.documentHandle,
        revision: info.revision,
        position: 0,
        length: 1
      })
    ).toEqual({ ok: false, error: 'unauthorized' })
  })

  it('accounts repeated range transfers instead of allowing unlimited rereads', async () => {
    const setup = await fixture(Buffer.alloc(PLUGIN_VIEWER_CHUNK_BYTES))
    const info = await setup.registry.create(viewerOwner, setup.file)
    const request = {
      documentHandle: info.documentHandle,
      revision: info.revision,
      position: 0,
      length: PLUGIN_VIEWER_CHUNK_BYTES
    }
    const allowed = Math.floor(PLUGIN_VIEWER_TRANSFER_BYTES / PLUGIN_VIEWER_CHUNK_BYTES)
    for (let index = 0; index < allowed; index++) {
      expect((await setup.registry.read(viewerOwner, request)).ok).toBe(true)
    }
    expect(await setup.registry.read(viewerOwner, request)).toEqual({
      ok: false,
      error: 'limit_exceeded'
    })
  })

  it('does not return bytes from a read revoked while it was in flight', async () => {
    const setup = await fixture()
    const delayed = delayedViewerRegistry()
    registries.push(delayed.registry)
    const info = await delayed.registry.create(viewerOwner, setup.file)
    const read = delayed.registry.read(viewerOwner, {
      documentHandle: info.documentHandle,
      revision: info.revision,
      position: 0,
      length: 1
    })
    await delayed.started.promise
    delayed.registry.revoke((owner) => owner.pluginKey === viewerOwner.pluginKey)
    delayed.gate.resolve()
    expect(await read).toEqual({ ok: false, error: 'cancelled' })
    await delayed.registry.dispose()
    expect(delayed.close).toHaveBeenCalledTimes(1)
  })
})
