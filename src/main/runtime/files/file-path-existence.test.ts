import { describe, expect, it, vi } from 'vitest'
import type { RuntimeFileExplorerPath, RuntimeLocalFileHost } from './file-target'
import { readRuntimeFilePathExistence } from './file-path-existence'

const stat = vi.hoisted(() => vi.fn())
vi.mock('./file-target', () => ({ requireRuntimeFileProvider: () => ({ stat }) }))

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: failed`), { code })
}

describe('readRuntimeFilePathExistence', () => {
  it('answers missing for a path under a file, and unverifiable for a denied one', async () => {
    stat.mockImplementation(async (path: string) => {
      if (path === '/srv/repo/a.txt/b.txt') {
        throw errno('ENOTDIR')
      }
      if (path === '/srv/repo/secret') {
        throw errno('EACCES')
      }
      return {}
    })
    const targets = ['/srv/repo/a.txt/b.txt', '/srv/repo/secret', '/srv/repo/a.txt'].map(
      (path): RuntimeFileExplorerPath => ({
        // SAFETY: the mocked provider ignores the worktree; only the path is read.
        worktree: {} as RuntimeFileExplorerPath['worktree'],
        path,
        executionHostId: 'local'
      })
    )

    await expect(
      // SAFETY: the mocked provider never reaches the host.
      readRuntimeFilePathExistence(targets, {} as RuntimeLocalFileHost)
    ).resolves.toEqual([{ exists: false }, { error: 'EACCES: failed' }, { exists: true }])
  })
})
