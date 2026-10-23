import { describe, expect, it, vi } from 'vitest'
import { openFilePathLinkAtBufferPosition } from './terminal-file-link-hit-testing'
import { openDetectedFilePath } from './terminal-file-open-routing'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import { getTerminalPathExistsCacheKey } from './terminal-path-exists-cache'
import { makeBuffer, makeBufferLine } from './terminal-link-provider-buffer-fixtures'
import {
  createDeferred,
  flushAsyncWork,
  flushDoubleRaf,
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, openFileMock, runtimeEnvironmentCallMock, statMock } = doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

const BUFFER = makeBuffer([
  makeBufferLine('/srv/repo/a.txt'),
  makeBufferLine('/srv/repo/b.txt'),
  makeBufferLine('/srv/repo/c.txt')
])

type HostAnswer = { exists: boolean } | { error: string }

/** The host answers both the batched probe and the open's stat from one table. */
function hostAnswers(answer: (relativePath: string) => HostAnswer): void {
  runtimeEnvironmentCallMock.mockImplementation(async (args) => {
    const meta = { runtimeId: 'remote-runtime' }
    if (args.method === 'files.pathsExist') {
      return { id: 'rpc-1', ok: true, result: args.params.relativePaths.map(answer), _meta: meta }
    }
    const row = answer(args.params.relativePath)
    if ('exists' in row && row.exists) {
      return {
        id: 'rpc-1',
        ok: true,
        result: { size: 1, isDirectory: false, mtime: 1 },
        _meta: meta
      }
    }
    const message = 'error' in row ? row.error : 'ENOENT: no such file or directory'
    return { id: 'rpc-1', ok: false, error: { code: 'runtime_error', message }, _meta: meta }
  })
}

function clickFirstPath(
  onOpenFailure = vi.fn(),
  pathExistsCache = new Map<string, boolean>()
): boolean {
  return openFilePathLinkAtBufferPosition(BUFFER, { x: 4, y: 1 }, 80, {
    startupCwd: '/srv/repo',
    worktreeId: 'wt-1',
    worktreePath: '/srv/repo',
    runtimeEnvironmentId: 'env-1',
    terminalHandle: 'term-1',
    pathExistsCache,
    onOpenFailure
  })
}

describe('a modifier-click on a paired-server path followed by more paths', () => {
  it('opens the clicked path, not the guess joining it to the rows below', async () => {
    setPlatform('Macintosh')
    // Why an error row: hosts before the ENOTDIR fix cannot answer for `a.txt/...`.
    hostAnswers((path) => (path === 'a.txt' ? { exists: true } : { error: 'ENOTDIR' }))
    const onOpenFailure = vi.fn()

    expect(clickFirstPath(onOpenFailure)).toBe(true)
    await flushDoubleRaf()

    expect(openFileMock).toHaveBeenCalledTimes(1)
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/srv/repo/a.txt' }),
      { forceContentReload: true }
    )
    expect(onOpenFailure).not.toHaveBeenCalled()
  })

  it('stops re-asking an older host about the joined guess it cannot answer', async () => {
    setPlatform('Macintosh')
    hostAnswers((path) => (path === 'a.txt' ? { exists: true } : { error: 'ENOTDIR' }))
    const pathExistsCache = new Map<string, boolean>()

    clickFirstPath(vi.fn(), pathExistsCache)
    await flushDoubleRaf()
    // Why: forget a.txt so the second click is as ambiguous as the first.
    pathExistsCache.clear()
    runtimeEnvironmentCallMock.mockClear()
    clickFirstPath(vi.fn(), pathExistsCache)
    await flushDoubleRaf()

    expect(runtimeEnvironmentCallMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.pathsExist' })
    )
    expect(openFileMock).toHaveBeenCalledTimes(2)
  })

  it('says why when the clicked path is gone, naming it rather than a joined guess', async () => {
    setPlatform('Macintosh')
    hostAnswers(() => ({ exists: false }))
    const onOpenFailure = vi.fn()

    clickFirstPath(onOpenFailure)
    await flushDoubleRaf()

    expect(openFileMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledWith(
      '/srv/repo/a.txt',
      expect.objectContaining({ verdict: 'missing' })
    )
  })

  it('does not call the path missing when the host cannot answer', async () => {
    setPlatform('Macintosh')
    hostAnswers(() => ({ error: 'host unreachable' }))
    const onOpenFailure = vi.fn()

    clickFirstPath(onOpenFailure)
    await flushDoubleRaf()

    expect(openFileMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledWith(
      '/srv/repo/a.txt',
      expect.objectContaining({ verdict: 'unverifiable' })
    )
  })

  it('drops a slow ambiguous probe once a later click has opened something else', async () => {
    setPlatform('Macintosh')
    const firstProbe = createDeferred<boolean>()
    vi.mocked(window.api.shell.pathExists).mockImplementation(async (path: string) =>
      path === '/repo/a.txt' ? firstProbe.promise : false
    )
    const buffer = makeBuffer([
      makeBufferLine('/repo/a.txt'),
      makeBufferLine('/repo/b.txt'),
      makeBufferLine(''),
      makeBufferLine('package.json')
    ])
    const deps = { startupCwd: '/repo', worktreeId: 'wt-1', worktreePath: '/repo' }

    openFilePathLinkAtBufferPosition(buffer, { x: 4, y: 1 }, 80, deps)
    // Why: a lone candidate opens without probing, and must still cancel the pending probe.
    openFilePathLinkAtBufferPosition(buffer, { x: 4, y: 4 }, 80, deps)
    firstProbe.resolve(true)
    await flushAsyncWork()

    expect(statMock).toHaveBeenCalledTimes(1)
    expect(statMock).toHaveBeenCalledWith({ filePath: '/repo/package.json' })
  })

  it('reports a missing path but stays quiet for a bare dotted word', async () => {
    setPlatform('Macintosh')
    // Why Once: a lasting rejection would leak into later tests.
    statMock
      .mockRejectedValueOnce(new Error('ENOENT: no such file'))
      .mockRejectedValueOnce(new Error('ENOENT: no such file'))
    const onOpenFailure = vi.fn()
    const deps = { startupCwd: '/repo', worktreeId: 'wt-1', worktreePath: '/repo', onOpenFailure }

    openFilePathLinkAtBufferPosition(
      makeBuffer([makeBufferLine('console.log')]),
      { x: 4, y: 1 },
      80,
      deps
    )
    await flushAsyncWork()
    expect(onOpenFailure).not.toHaveBeenCalled()

    openFilePathLinkAtBufferPosition(
      makeBuffer([makeBufferLine('src/gone.ts')]),
      { x: 4, y: 1 },
      80,
      deps
    )
    await flushAsyncWork()
    expect(onOpenFailure).toHaveBeenCalledWith(
      '/repo/src/gone.ts',
      expect.objectContaining({ verdict: 'missing' })
    )
  })

  it('checks a longer hard-wrapped name before opening its cached prefix', async () => {
    setPlatform('Macintosh')
    vi.mocked(window.api.shell.pathExists).mockImplementation(
      async (path: string) => path === '/repo/foo.ts.map'
    )
    const buffer = makeBuffer([makeBufferLine('/repo/foo.ts'), makeBufferLine('.map')])
    const pathExistsCache = new Map([
      [getTerminalPathExistsCacheKey({ absolutePath: '/repo/foo.ts' }), true]
    ])
    const deps = { startupCwd: '/repo', worktreeId: 'wt-1', worktreePath: '/repo', pathExistsCache }

    openFilePathLinkAtBufferPosition(buffer, { x: 4, y: 1 }, 80, deps)
    await flushAsyncWork()

    expect(statMock).toHaveBeenCalledTimes(1)
    expect(statMock).toHaveBeenCalledWith({ filePath: '/repo/foo.ts.map' })
  })

  it('drops a slow ambiguous probe once any other file open has started', async () => {
    setPlatform('Macintosh')
    const probe = createDeferred<boolean>()
    vi.mocked(window.api.shell.pathExists).mockImplementation(() => probe.promise)
    const deps = { startupCwd: '/repo', worktreeId: 'wt-1', worktreePath: '/repo' }

    openFilePathLinkAtBufferPosition(
      makeBuffer([makeBufferLine('/repo/a.txt'), makeBufferLine('/repo/b.txt')]),
      { x: 4, y: 1 },
      80,
      deps
    )
    // Why: e.g. a chat link or the link popover, which never passes through the click fallback.
    openDetectedFilePath('/repo/other.txt', null, null, deps)
    probe.resolve(true)
    await flushAsyncWork()

    expect(statMock).toHaveBeenCalledTimes(1)
    expect(statMock).toHaveBeenCalledWith({ filePath: '/repo/other.txt' })
  })

  it('supersedes an earlier open still in flight as soon as an ambiguous click starts', async () => {
    setPlatform('Macintosh')
    const earlierStat = createDeferred<{ isDirectory: boolean }>()
    statMock.mockImplementationOnce(() => earlierStat.promise)
    const probe = createDeferred<boolean>()
    vi.mocked(window.api.shell.pathExists).mockImplementation(async (path: string) =>
      path === '/repo/a.txt' ? probe.promise : false
    )
    const deps = { startupCwd: '/repo', worktreeId: 'wt-1', worktreePath: '/repo' }

    openDetectedFilePath('/repo/earlier.txt', null, null, deps)
    openFilePathLinkAtBufferPosition(
      makeBuffer([makeBufferLine('/repo/a.txt'), makeBufferLine('/repo/b.txt')]),
      { x: 4, y: 1 },
      80,
      deps
    )
    earlierStat.resolve({ isDirectory: false })
    await flushAsyncWork()
    expect(openFileMock).not.toHaveBeenCalled()

    probe.resolve(true)
    await flushDoubleRaf()
    expect(openFileMock).toHaveBeenCalledTimes(1)
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/a.txt' }),
      { forceContentReload: true }
    )
  })
})
