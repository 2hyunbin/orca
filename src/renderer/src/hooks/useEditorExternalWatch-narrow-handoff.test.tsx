// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

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
  return {
    snapshot,
    reverify: vi.fn()
  }
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
  reverifyEditorTabsAfterNarrowWatch: state.reverify
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
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

  beforeEach(() => {
    vi.clearAllMocks()
    watchWorktree = vi.fn().mockResolvedValue(undefined)
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

  it('releases the recursive watch only after the narrow replacement subscribed', async () => {
    await render([recursive], 'recursive')
    const narrowSubscribed = deferred()
    watchWorktree.mockReturnValueOnce(narrowSubscribed.promise)

    await render([narrow], 'narrow')

    expect(watchWorktree).toHaveBeenLastCalledWith({
      worktreePath: '/repo/wt',
      connectionId: undefined,
      narrowFiles: ['src/a.ts']
    })
    expect(unwatchWorktree).not.toHaveBeenCalled()

    await act(async () => {
      narrowSubscribed.resolve()
      await narrowSubscribed.promise
    })

    expect(unwatchWorktree).toHaveBeenCalledTimes(1)
    expect(unwatchWorktree).toHaveBeenCalledWith({
      worktreePath: '/repo/wt',
      connectionId: undefined
    })
    expect(state.reverify).not.toHaveBeenCalled()
  })

  it('re-verifies tabs once the recursive watch is back, then drops the narrow watch', async () => {
    await render([narrow], 'narrow')
    const recursiveSubscribed = deferred()
    watchWorktree.mockReturnValueOnce(recursiveSubscribed.promise)

    await render([recursive], 'recursive')
    expect(unwatchWorktree).not.toHaveBeenCalled()
    expect(state.reverify).not.toHaveBeenCalled()

    await act(async () => {
      recursiveSubscribed.resolve()
      await recursiveSubscribed.promise
    })

    expect(unwatchWorktree).toHaveBeenCalledWith({
      worktreePath: '/repo/wt',
      connectionId: undefined,
      narrowFiles: ['src/a.ts']
    })
    expect(state.reverify).toHaveBeenCalledTimes(1)
    expect(state.reverify).toHaveBeenCalledWith(recursive)
  })

  it('keeps a watch that was re-requested before its deferred release ran', async () => {
    await render([recursive], 'recursive')
    const narrowSubscribed = deferred()
    watchWorktree.mockReturnValueOnce(narrowSubscribed.promise)
    await render([narrow], 'narrow')
    await render([recursive], 'recursive-again')

    await act(async () => {
      narrowSubscribed.resolve()
      await narrowSubscribed.promise
    })

    expect(unwatchWorktree).not.toHaveBeenCalledWith({
      worktreePath: '/repo/wt',
      connectionId: undefined
    })
  })
})
