// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { WatchWorktreeStatus } from '../../../shared/filesystem-entry-types'

type TestWatchTarget = {
  worktreeId: string
  worktreePath: string
  connectionId: string | undefined
  runtimeEnvironmentId: string | null
  narrowFiles?: string[]
}

const state = vi.hoisted(() => {
  const snapshot: { targets: TestWatchTarget[]; targetsKey: string } = {
    targets: [],
    targetsKey: ''
  }
  return { snapshot, arm: vi.fn(), reloadClean: vi.fn() }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (value: unknown) => unknown) => selector({})
}))
vi.mock('./editor-external-watch-targets', () => ({
  selectEditorExternalWatchTargets: () => state.snapshot,
  getEditorExternalWatchTargetKey: (target: TestWatchTarget) =>
    [
      target.worktreeId,
      target.worktreePath,
      target.connectionId ?? 'local',
      target.runtimeEnvironmentId ?? 'client',
      target.narrowFiles ? JSON.stringify(target.narrowFiles) : ''
    ].join('::')
}))
vi.mock('./editor-external-watch-event-reconciliation', () => ({
  buildEditorExternalWatchEventHandler: vi.fn(() => ({
    handleFsChanged: vi.fn(),
    dispose: vi.fn()
  }))
}))
vi.mock('./editor-external-watch-disk-verification', () => ({
  verifyLatchedEditorMoveDestinations: vi.fn()
}))
vi.mock('./editor-external-watch-activation-reverify', () => ({
  armEditorTabDiskVerification: state.arm,
  reloadCleanEditorTabs: state.reloadClean
}))
vi.mock('./editor-runtime-file-watch', () => ({ subscribeEditorRuntimeFileWatch: vi.fn() }))

import { useEditorExternalWatch } from './useEditorExternalWatch'

function WatchProbe(): null {
  useEditorExternalWatch()
  return null
}

const recursive: TestWatchTarget = {
  worktreeId: 'wt',
  worktreePath: '/repo/wt',
  connectionId: undefined,
  runtimeEnvironmentId: null
}
const narrow: TestWatchTarget = { ...recursive, narrowFiles: ['src/a.ts'] }
const recursiveArgs = { worktreePath: '/repo/wt', connectionId: undefined }
const narrowArgs = { ...recursiveArgs, narrowFiles: ['src/a.ts'] }

function deferred(): {
  promise: Promise<WatchWorktreeStatus>
  resolve: (status: WatchWorktreeStatus) => void
} {
  let resolve!: (status: WatchWorktreeStatus) => void
  const promise = new Promise<WatchWorktreeStatus>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('useEditorExternalWatch recursive/narrow handoff', () => {
  let previousApi: unknown
  let container: HTMLDivElement
  let root: Root
  let watchWorktree: ReturnType<typeof vi.fn>
  let unwatchWorktree: ReturnType<typeof vi.fn>

  const render = async (targets: TestWatchTarget[], targetsKey: string): Promise<void> => {
    state.snapshot = { targets, targetsKey }
    await act(async () => root.render(createElement(WatchProbe)))
  }
  const settle = async (
    pending: ReturnType<typeof deferred>,
    status: WatchWorktreeStatus
  ): Promise<void> => {
    await act(async () => {
      pending.resolve(status)
      await pending.promise
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    watchWorktree = vi.fn().mockResolvedValue('installed')
    unwatchWorktree = vi.fn().mockResolvedValue(undefined)
    previousApi = Reflect.get(window, 'api')
    Reflect.set(window, 'api', {
      fs: { watchWorktree, unwatchWorktree, onFsChanged: vi.fn(() => vi.fn()) }
    })
    container = document.body.appendChild(document.createElement('div'))
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    Reflect.set(window, 'api', previousApi)
  })

  it('releases the recursive watch only after the narrow replacement installed', async () => {
    await render([recursive], 'recursive')
    const narrowSubscribed = deferred()
    watchWorktree.mockReturnValueOnce(narrowSubscribed.promise)

    await render([narrow], 'narrow')
    expect(watchWorktree).toHaveBeenLastCalledWith(narrowArgs)
    expect(unwatchWorktree).not.toHaveBeenCalled()

    await settle(narrowSubscribed, 'installed')
    expect(unwatchWorktree).toHaveBeenCalledTimes(1)
    expect(unwatchWorktree).toHaveBeenCalledWith(recursiveArgs)
    expect(state.arm).not.toHaveBeenCalled()
  })

  it('arms dirty-tab verification before the full-tree install resolves, then reloads clean tabs', async () => {
    await render([narrow], 'narrow')
    const recursiveSubscribed = deferred()
    watchWorktree.mockReturnValueOnce(recursiveSubscribed.promise)

    await render([recursive], 'recursive')
    // Why: autosave must already be suspended while the crawl runs; the narrow watch still covers the gap.
    expect(state.arm).toHaveBeenCalledWith(recursive)
    expect(state.reloadClean).not.toHaveBeenCalled()
    expect(unwatchWorktree).not.toHaveBeenCalled()

    await settle(recursiveSubscribed, 'installed')
    expect(unwatchWorktree).toHaveBeenCalledWith(narrowArgs)
    expect(state.reloadClean).toHaveBeenCalledWith(recursive)
  })

  it.each([
    ['narrow → recursive', narrow, recursive, recursiveArgs, narrowArgs],
    ['recursive → narrow', recursive, narrow, narrowArgs, recursiveArgs]
  ] as const)(
    'keeps the old watch while the %s replacement is pending or unavailable',
    async (_label, from, to, toArgs, fromArgs) => {
      for (const status of ['pending', 'unavailable'] as const) {
        unwatchWorktree.mockClear()
        await render([from], `from-${status}`)
        const replacement = deferred()
        watchWorktree.mockReturnValueOnce(replacement.promise)
        await render([to], `to-${status}`)
        await settle(replacement, status)
        expect(unwatchWorktree).not.toHaveBeenCalledWith(fromArgs)

        // The held watch goes away together with its replacement.
        await render([], `none-${status}`)
        expect(unwatchWorktree).toHaveBeenCalledWith(toArgs)
        expect(unwatchWorktree).toHaveBeenCalledWith(fromArgs)
      }
    }
  )

  it('keeps a watch that was re-requested before its deferred release ran', async () => {
    await render([recursive], 'recursive')
    const narrowSubscribed = deferred()
    watchWorktree.mockReturnValueOnce(narrowSubscribed.promise)
    await render([narrow], 'narrow')
    await render([recursive], 'recursive-again')

    await settle(narrowSubscribed, 'installed')
    expect(unwatchWorktree).not.toHaveBeenCalledWith(recursiveArgs)
  })
})
