import { describe, expect, it, vi } from 'vitest'
import { openFilePathLinkAtBufferPosition } from './terminal-file-link-hit-testing'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
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

function hostAnswers(
  answer: (relativePath: string) => { exists: boolean } | { error: string }
): void {
  runtimeEnvironmentCallMock.mockImplementation(async (args) => ({
    id: 'rpc-1',
    ok: true,
    result:
      args.method === 'files.pathsExist'
        ? args.params.relativePaths.map(answer)
        : { size: 1, isDirectory: false, mtime: 1 },
    _meta: { runtimeId: 'remote-runtime' }
  }))
}

function clickFirstPath(onOpenFailure = vi.fn()): boolean {
  return openFilePathLinkAtBufferPosition(BUFFER, { x: 4, y: 1 }, 80, {
    startupCwd: '/srv/repo',
    worktreeId: 'wt-1',
    worktreePath: '/srv/repo',
    runtimeEnvironmentId: 'env-1',
    terminalHandle: 'term-1',
    pathExistsCache: new Map(),
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
})
