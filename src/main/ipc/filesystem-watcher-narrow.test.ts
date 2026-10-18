import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangedPayload } from '../../shared/filesystem-entry-types'
import { createWatcherSender } from './filesystem-watcher-test-sender'

const { handleMock, statMock, subscribeMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  statMock: vi.fn(),
  subscribeMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('fs/promises', () => ({ stat: statMock }))
vi.mock('./parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: subscribeMock,
  disposeWatcherProcess: vi.fn()
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn(),
  onSshFilesystemProviderRegistered: () => () => {}
}))

import {
  closeAllWatchers,
  closeLocalWatcherForWorktreePath,
  registerFilesystemWatcherHandlers
} from './filesystem-watcher'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { normalizeNarrowWatchFiles, parseLocalWatcherKey } from './filesystem-watcher-narrow-roots'
import { WatcherChildCapacityError } from './parcel-watcher-child-registry'

type HandlerMap = Record<string, (event: unknown, args: unknown) => unknown>
type WatcherCallback = (error: Error | null, events: { type: string; path: string }[]) => void

function enoent(): Error {
  return Object.assign(new Error('missing'), { code: 'ENOENT' })
}

describe('narrow (non-recursive) local watches', () => {
  const handlers: HandlerMap = {}
  const callbacks: WatcherCallback[] = []
  const unsubscribes: ReturnType<typeof vi.fn>[] = []

  beforeEach(async () => {
    vi.useRealTimers()
    handleMock.mockReset()
    statMock.mockReset()
    subscribeMock.mockReset()
    callbacks.length = 0
    unsubscribes.length = 0
    handleMock.mockImplementation((channel: string, handler: HandlerMap[string]) => {
      handlers[channel] = handler
    })
    statMock.mockResolvedValue({ isDirectory: () => true })
    subscribeMock.mockImplementation(async (_dir: string, callback: WatcherCallback) => {
      callbacks.push(callback)
      const unsubscribe = vi.fn().mockResolvedValue(undefined)
      unsubscribes.push(unsubscribe)
      return { unsubscribe }
    })
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
  })

  it('subscribes the open files shallowly, as a root separate from the recursive watch', async () => {
    const sender = createWatcherSender(1)
    await handlers['fs:watchWorktree'](
      { sender },
      { worktreePath: '/repo', narrowFiles: ['src/b.ts', 'src/a.ts', './src/a.ts'] }
    )
    await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/repo' })

    expect(subscribeMock).toHaveBeenCalledTimes(2)
    expect(subscribeMock.mock.calls[0][2]).toEqual({
      mode: 'shallow',
      include: ['src/a.ts', 'src/b.ts']
    })
    expect(subscribeMock.mock.calls[1][2]).not.toHaveProperty('mode')
    const keys = [...watcherLifecycleState.watchedRoots.keys()].map(parseLocalWatcherKey)
    expect(keys).toEqual(
      expect.arrayContaining([
        { baseKey: '/repo' },
        { baseKey: '/repo', narrowFiles: ['src/a.ts', 'src/b.ts'] }
      ])
    )
    await closeAllWatchers()
  })

  it('delivers narrow events as fs:changed for the workspace and turns a vanished file into a delete', async () => {
    const sender = createWatcherSender(1)
    await handlers['fs:watchWorktree'](
      { sender },
      { worktreePath: '/repo', narrowFiles: ['src/a.ts', 'src/gone.ts'] }
    )
    statMock.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('gone.ts')) {
        throw enoent()
      }
      return { isDirectory: () => false }
    })

    callbacks[0](null, [
      { type: 'update', path: '/repo/src/a.ts' },
      { type: 'update', path: '/repo/src/gone.ts' }
    ])
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledTimes(1))
    const [channel, sentPayload] = sender.send.mock.calls[0]
    const payload: FsChangedPayload = sentPayload
    expect(channel).toBe('fs:changed')
    expect(payload.worktreePath).toBe('/repo')
    expect(payload.events).toEqual([
      { kind: 'update', absolutePath: '/repo/src/a.ts', isDirectory: false },
      { kind: 'delete', absolutePath: '/repo/src/gone.ts', isDirectory: undefined }
    ])
    await closeAllWatchers()
  })

  it('unwatches only the narrow root named by the request', async () => {
    const sender = createWatcherSender(1)
    await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/repo' })
    await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/repo', narrowFiles: ['a.ts'] })

    handlers['fs:unwatchWorktree']({ sender }, { worktreePath: '/repo', narrowFiles: ['a.ts'] })

    const listenerCounts = [...watcherLifecycleState.watchedRoots].map(([key, root]) => [
      parseLocalWatcherKey(key).narrowFiles ?? null,
      root.listeners.size
    ])
    expect(listenerCounts).toEqual(
      expect.arrayContaining([
        [null, 1],
        [['a.ts'], 0]
      ])
    )
    await closeAllWatchers()
  })

  it('closes narrow roots inside a worktree being removed, even during the teardown grace', async () => {
    const sender = createWatcherSender(1)
    await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/repo', narrowFiles: ['a.ts'] })
    await handlers['fs:watchWorktree'](
      { sender },
      { worktreePath: '/repo-other', narrowFiles: ['a.ts'] }
    )
    handlers['fs:unwatchWorktree']({ sender }, { worktreePath: '/repo', narrowFiles: ['a.ts'] })

    await closeLocalWatcherForWorktreePath('/repo')

    expect(unsubscribes[0]).toHaveBeenCalledTimes(1)
    expect(unsubscribes[1]).not.toHaveBeenCalled()
    expect(
      [...watcherLifecycleState.watchedRoots.keys()].map((key) => parseLocalWatcherKey(key).baseKey)
    ).toEqual(['/repo-other'])
    await closeAllWatchers()
  })

  it('reports installed for both recursive and narrow watches', async () => {
    const sender = createWatcherSender(1)
    await expect(handlers['fs:watchWorktree']({ sender }, { worktreePath: '/repo' })).resolves.toBe(
      'installed'
    )
    await expect(
      handlers['fs:watchWorktree']({ sender }, { worktreePath: '/repo', narrowFiles: ['a.ts'] })
    ).resolves.toBe('installed')
    await closeAllWatchers()
  })

  it('falls back to a whole-tree watch under the narrow key when the shallow install fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    subscribeMock.mockRejectedValueOnce(new Error('Shallow watcher delivery unavailable'))
    const sender = createWatcherSender(1)
    try {
      await expect(
        handlers['fs:watchWorktree']({ sender }, { worktreePath: '/repo', narrowFiles: ['a.ts'] })
      ).resolves.toBe('installed')
      expect(subscribeMock).toHaveBeenCalledTimes(2)
      expect(subscribeMock.mock.calls[1][2]).not.toHaveProperty('mode')
      expect([...watcherLifecycleState.watchedRoots.keys()].map(parseLocalWatcherKey)).toEqual([
        { baseKey: '/repo', narrowFiles: ['a.ts'] }
      ])
    } finally {
      warn.mockRestore()
      error.mockRestore()
      await closeAllWatchers()
    }
  })

  it('treats an empty narrow set as a whole-tree watch', async () => {
    const sender = createWatcherSender(1)
    await expect(
      handlers['fs:watchWorktree']({ sender }, { worktreePath: '/repo', narrowFiles: ['../x'] })
    ).resolves.toBe('installed')
    expect(subscribeMock.mock.calls[0][2]).not.toHaveProperty('mode')
    await closeAllWatchers()
  })

  it.each([
    ['narrow', ['a.ts']],
    ['recursive', undefined]
  ])('reports pending while a %s install waits on watcher capacity', async (_mode, narrowFiles) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    subscribeMock.mockRejectedValueOnce(new WatcherChildCapacityError())
    const sender = createWatcherSender(1)
    try {
      await expect(
        handlers['fs:watchWorktree']({ sender }, { worktreePath: '/repo', narrowFiles })
      ).resolves.toBe('pending')
    } finally {
      error.mockRestore()
      await closeAllWatchers()
    }
  })

  it('ignores narrowFiles for SSH watches, which stay recursive on the relay', async () => {
    const sender = createWatcherSender(1)
    await handlers['fs:watchWorktree'](
      { sender },
      { worktreePath: '/remote', connectionId: 'ssh-1', narrowFiles: ['a.ts'] }
    )
    expect(subscribeMock).not.toHaveBeenCalled()
    await closeAllWatchers()
  })
})

describe('normalizeNarrowWatchFiles', () => {
  it('keeps worktree-relative files and drops escapes, absolutes and junk', () => {
    expect(
      normalizeNarrowWatchFiles(['b/c.ts', 'a.ts', './a.ts', '../x.ts', '/etc/passwd', '', 3])
    ).toEqual(['a.ts', 'b/c.ts'])
    expect(normalizeNarrowWatchFiles(undefined)).toBeUndefined()
  })
})
