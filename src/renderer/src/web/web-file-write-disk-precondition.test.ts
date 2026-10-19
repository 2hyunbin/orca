import { describe, expect, it, vi } from 'vitest'
import { getDiskBaselineSignature } from '../../../shared/disk-baseline-signature'
import { FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY } from '../../../shared/file-write-disk-precondition'
import { createWebFileMutationMethods } from './web-file-mutation-methods'

const precondition = { expectedSignature: getDiskBaselineSignature('original') }

function methodsFor(
  capabilities: readonly string[],
  diskContent: string | null,
  readError = "ENOENT: no such file or directory, stat '/hub/repo/readme.md'"
) {
  const callRuntimeResult = vi.fn(async (method: string, _params: unknown): Promise<unknown> => {
    if (method === 'files.readPreview') {
      if (diskContent === null) {
        throw new Error(readError)
      }
      return { content: diskContent, isBinary: false }
    }
    return { ok: true }
  })
  const methods = createWebFileMutationMethods({
    captureSession: () => ({
      assertMutationSupported: async () => capabilities,
      callRuntimeResult,
      getSshState: async () => null,
      resolveFilePath: async () => ({
        worktree: { id: 'wt-local', hostId: 'local' },
        relativePath: 'readme.md'
      })
    })
  })
  const calledMethods = () => callRuntimeResult.mock.calls.map(([method]) => method)
  return { methods, callRuntimeResult, calledMethods }
}

describe('paired web client save precondition', () => {
  it('lets a server that enforces the precondition compare at write time', async () => {
    const { methods, callRuntimeResult, calledMethods } = methodsFor(
      [FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY],
      'original'
    )

    await methods.writeFile({
      filePath: '/hub/repo/readme.md',
      content: 'edited',
      diskPrecondition: precondition
    })

    expect(calledMethods()).toEqual(['files.writeIfUnchanged'])
    expect(callRuntimeResult.mock.calls[0]?.[1]).toMatchObject({ diskPrecondition: precondition })
  })

  it('refuses without writing when an older server holds newer disk content', async () => {
    const { methods, calledMethods } = methodsFor([], 'agent rewrite')

    const result = await methods.writeFile({
      filePath: '/hub/repo/readme.md',
      content: 'edited',
      diskPrecondition: precondition
    })

    expect(result).toEqual({ ok: false, diskConflict: 'changed' })
    expect(calledMethods()).toEqual(['files.readPreview'])
  })

  it('writes through an older server without the field once the disk matches', async () => {
    const { methods, callRuntimeResult, calledMethods } = methodsFor([], 'original')

    const result = await methods.writeFile({
      filePath: '/hub/repo/readme.md',
      content: 'edited',
      diskPrecondition: precondition
    })

    expect(result).toEqual({ ok: true })
    expect(calledMethods()).toEqual(['files.readPreview', 'files.write'])
    expect(callRuntimeResult.mock.calls[1]?.[1]).not.toHaveProperty('diskPrecondition')
  })

  it('reports a confirmed-missing file to an autosave through an older server', async () => {
    const { methods, calledMethods } = methodsFor([], null)

    const result = await methods.writeFile({
      filePath: '/hub/repo/readme.md',
      content: 'edited',
      diskPrecondition: precondition
    })

    expect(result).toEqual({ ok: false, diskConflict: 'missing' })
    expect(calledMethods()).toEqual(['files.readPreview'])
  })

  it('fails an explicit save, without writing, when an older server read fails otherwise', async () => {
    const { methods, calledMethods } = methodsFor([], null, 'Runtime request timed out')

    await expect(
      methods.writeFile({
        filePath: '/hub/repo/readme.md',
        content: 'edited',
        diskPrecondition: { ...precondition, allowMissing: true }
      })
    ).rejects.toThrow('timed out')
    expect(calledMethods()).toEqual(['files.readPreview'])
  })

  it('reports a file an older server refuses as file_too_large as changed', async () => {
    // The paired client surfaces a failed envelope as an Error carrying the wire message.
    const { methods, calledMethods } = methodsFor([], null, 'file_too_large')

    const result = await methods.writeFile({
      filePath: '/hub/repo/readme.md',
      content: 'edited',
      diskPrecondition: { ...precondition, allowMissing: true }
    })

    expect(result).toEqual({ ok: false, diskConflict: 'changed' })
    expect(calledMethods()).toEqual(['files.readPreview'])
  })
})
