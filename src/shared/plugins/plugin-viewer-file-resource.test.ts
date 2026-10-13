import { open, mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import type * as NodeFilesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openPluginViewerFileResource } from './plugin-viewer-file-resource'
import { PLUGIN_VIEWER_CHUNK_BYTES } from './plugin-viewer-document'

vi.mock('node:fs/promises', async (original) => {
  const filesystem = await original<typeof NodeFilesystem>()
  return { ...filesystem, open: vi.fn(filesystem.open) }
})

const roots: string[] = []
afterEach(async () => {
  vi.mocked(open).mockReset()
  const filesystem = await vi.importActual<typeof NodeFilesystem>('node:fs/promises')
  vi.mocked(open).mockImplementation(filesystem.open)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-viewer-revision-'))
  roots.push(root)
  const boundaryPath = join(root, 'folder')
  await mkdir(boundaryPath)
  const entryPath = join(boundaryPath, 'model.stl')
  await writeFile(entryPath, Buffer.from([0, 255, 1, 0, 200]))
  return { boundaryPath, entryPath }
}

describe('authorized positional file resource', () => {
  it('withholds a chunk when the real file changes during the underlying read', async () => {
    const file = await fixture()
    const filesystem = await vi.importActual<typeof NodeFilesystem>('node:fs/promises')
    vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
      const handle = await filesystem.open(path, flags, mode)
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementationOnce(async (...args) => {
        const result = await read(...args)
        await writeFile(file.entryPath, 'other')
        await utimes(file.entryPath, new Date(0), new Date(0))
        return result
      })
      return handle
    })
    const signal = new AbortController().signal
    const resource = await openPluginViewerFileResource(file, signal)
    try {
      await expect(resource.read(0, 5, signal)).rejects.toMatchObject({ code: 'stale_revision' })
    } finally {
      await resource.close()
    }
  })

  it('fills short system reads without assuming that a short syscall means EOF', async () => {
    const file = await fixture()
    const filesystem = await vi.importActual<typeof NodeFilesystem>('node:fs/promises')
    vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
      const handle = await filesystem.open(path, flags, mode)
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementationOnce((options = {}) =>
        read({ ...options, length: 1 })
      )
      return handle
    })
    const signal = new AbortController().signal
    const resource = await openPluginViewerFileResource(file, signal)
    try {
      expect(await resource.read(0, 5, signal)).toEqual(Buffer.from([0, 255, 1, 0, 200]))
      await expect(resource.read(0, PLUGIN_VIEWER_CHUNK_BYTES + 1, signal)).rejects.toMatchObject({
        code: 'invalid_request'
      })
    } finally {
      await resource.close()
    }
  })
})
