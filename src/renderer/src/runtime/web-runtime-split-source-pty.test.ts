import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { splitWhenHostPublishesSource } from './web-runtime-split-source-pty'

type FakeState = {
  activeWorktreeId: string | null
  tabsByWorktree: Record<string, { id: string }[]>
  terminalLayoutsByTabId: Record<
    string,
    {
      root: { type: 'leaf'; leafId: string } | null
      activeLeafId: string | null
      ptyIdsByLeafId?: Record<string, string>
    }
  >
}

const mocks = vi.hoisted(() => {
  const state: { current: FakeState | null } = { current: null }
  const owner: { environmentId: string | null } = { environmentId: 'env-1' }
  return { state, owner, listeners: new Set<() => void>(), toastError: vi.fn() }
})

vi.mock('../store', () => ({
  useAppStore: {
    getState: () => mocks.state.current,
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
}))
vi.mock('../lib/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => mocks.owner.environmentId
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const TAB = 'web-terminal-host-tab-1'
const SOURCE = { worktreeId: 'worktree-1', tabId: TAB, leafId: 'leaf-1' }
const PTY = 'remote:env-1@@terminal-1'

function publish(next: Partial<FakeState>): void {
  mocks.state.current = { ...mocks.state.current!, ...next }
  for (const listener of mocks.listeners) {
    listener()
  }
}

function sourceLayout(
  ptyIdsByLeafId?: Record<string, string>
): FakeState['terminalLayoutsByTabId'] {
  return {
    [TAB]: {
      root: { type: 'leaf', leafId: 'leaf-1' },
      activeLeafId: 'leaf-1',
      ...(ptyIdsByLeafId ? { ptyIdsByLeafId } : {})
    }
  }
}

describe('splitWhenHostPublishesSource', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.owner.environmentId = 'env-1'
    mocks.listeners.clear()
    mocks.toastError.mockReset()
    mocks.state.current = {
      activeWorktreeId: 'worktree-1',
      tabsByWorktree: { 'worktree-1': [{ id: TAB }] },
      terminalLayoutsByTabId: sourceLayout()
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('splits once the server publishes the source terminal, and stops watching', () => {
    const split = vi.fn()
    splitWhenHostPublishesSource(SOURCE, split)
    expect(split).not.toHaveBeenCalled()

    publish({ terminalLayoutsByTabId: sourceLayout({ 'leaf-1': PTY }) })

    expect(split).toHaveBeenCalledExactlyOnceWith(PTY, false)
    expect(mocks.listeners.size).toBe(0)
    vi.runAllTimers()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('reports that the user moved elsewhere while waiting', () => {
    const split = vi.fn()
    splitWhenHostPublishesSource(SOURCE, split)

    publish({ activeWorktreeId: 'worktree-2' })
    publish({ terminalLayoutsByTabId: sourceLayout({ 'leaf-1': PTY }) })

    expect(split).toHaveBeenCalledExactlyOnceWith(PTY, true)
  })

  it.each([
    [
      'the source pane closes',
      () =>
        publish({
          terminalLayoutsByTabId: {
            [TAB]: { root: { type: 'leaf', leafId: 'leaf-2' }, activeLeafId: 'leaf-2' }
          }
        })
    ],
    ['the tab goes', () => publish({ tabsByWorktree: { 'worktree-1': [] } })],
    [
      'the server unpairs',
      () => {
        mocks.owner.environmentId = null
        publish({})
      }
    ]
  ])('gives up quietly when %s', (_case, change) => {
    const split = vi.fn()
    splitWhenHostPublishesSource(SOURCE, split)

    change()

    expect(mocks.listeners.size).toBe(0)
    vi.runAllTimers()
    expect(split).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  // A hydration can move the workspace to another server and publish its bindings in one commit.
  it('never splits on a server other than the one the gesture targeted', () => {
    const split = vi.fn()
    splitWhenHostPublishesSource(SOURCE, split)

    mocks.owner.environmentId = 'env-2'
    publish({ terminalLayoutsByTabId: sourceLayout({ 'leaf-1': 'remote:env-2@@terminal-9' }) })

    expect(split).not.toHaveBeenCalled()
    expect(mocks.listeners.size).toBe(0)
  })

  it('ignores a binding that names another server', () => {
    const split = vi.fn()
    splitWhenHostPublishesSource(SOURCE, split)

    publish({ terminalLayoutsByTabId: sourceLayout({ 'leaf-1': 'remote:env-2@@terminal-9' }) })
    expect(split).not.toHaveBeenCalled()
    publish({ terminalLayoutsByTabId: sourceLayout({ 'leaf-1': PTY }) })
    expect(split).toHaveBeenCalledExactlyOnceWith(PTY, false)
  })

  it('tells the user when the server never publishes the source terminal', () => {
    const split = vi.fn()
    splitWhenHostPublishesSource(SOURCE, split, 1_000)

    vi.advanceTimersByTime(1_000)

    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(mocks.listeners.size).toBe(0)
    publish({ terminalLayoutsByTabId: sourceLayout({ 'leaf-1': PTY }) })
    expect(split).not.toHaveBeenCalled()
  })
})
