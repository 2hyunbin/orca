import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeMetaPersistModule from '../worktrees/metadata/worktree-meta-persist'
import { makeWorktree } from '../worktrees-slice-test-fixtures'
import {
  addLiveTerminalTab,
  completeAgentTurn,
  createAttentionStore,
  installAttentionMockApi,
  LEAF_1,
  LEAF_2,
  observe,
  pointerDownInTab,
  ringBell,
  setWindowOnScreen,
  toggleUnreadByUser,
  typeInPane,
  WS_A,
  type AttentionStore
} from './workspace-unread-characterization-driver'

// On screen means read, the flag follows its markers, and reads retire OS notifications.

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() }
}))

vi.mock('../worktrees/metadata/worktree-meta-persist', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeMetaPersistModule>()
  return { ...actual, persistWorktreeMeta: vi.fn(async () => undefined) }
})

let dismiss: ReturnType<typeof installAttentionMockApi>

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1000)
  dismiss = installAttentionMockApi()
})

afterEach(() => {
  vi.useRealTimers()
})

/** A tab split into LEAF_1 | LEAF_2. */
function splitTab(store: AttentionStore, tabId: string): void {
  const s = store.getState()
  store.setState({
    terminalLayoutsByTabId: {
      ...s.terminalLayoutsByTabId,
      [tabId]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_1 },
          second: { type: 'leaf', leafId: LEAF_2 }
        },
        activeLeafId: LEAF_1,
        expandedLeafId: null
      }
    }
  })
}

const dismissedPaneKeys = (): string[][] =>
  dismiss.mock.calls.map((call) => [...(call[1] ?? [])].sort())

describe('on screen means read', () => {
  it('a bell on screen waits while the window is unfocused and is read when focus returns', () => {
    const { store, persists } = createAttentionStore({ windowOnScreen: false })
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    store.getState().setActiveWorktree(WS_A)
    observe(store, persists)

    ringBell(store, pane)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:1000 b@local:read:0 sortEpoch=1",
        "tabs tab-a1=terminal-bell",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
      ]
    `)
    expect(dismiss).not.toHaveBeenCalled()

    setWindowOnScreen(store, true)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:1000 b@local:read:0 sortEpoch=1",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":false}",
      ]
    `)
    expect(dismissedPaneKeys()).toEqual([[pane.paneKey]])
  })

  it('a bell in the focused pane on screen is read and its notification dismissed', () => {
    const { store, persists } = createAttentionStore()
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    store.getState().setActiveWorktree(WS_A)
    observe(store, persists)

    ringBell(store, pane)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:1000 b@local:read:0 sortEpoch=1",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":true,"lastActivityAt":1000}",
        "persist worktree a {"isUnread":false}",
      ]
    `)
    expect(dismissedPaneKeys()).toEqual([[pane.paneKey]])
  })

  it('a tab-level bell dismisses every pane of its split tab; a pane completion only its pane', () => {
    const { store } = createAttentionStore()
    addLiveTerminalTab(store, WS_A, 'tab-a1')
    const hidden = addLiveTerminalTab(store, WS_A, 'tab-a2', LEAF_1)
    splitTab(store, 'tab-a2')
    store.getState().setActiveWorktree(WS_A)
    store.getState().activateTab('unified-tab-a1')

    ringBell(store, hidden)
    completeAgentTurn(store, { worktreeId: WS_A, paneKey: `tab-a2:${LEAF_2}` })
    expect(dismiss).not.toHaveBeenCalled()

    store.getState().activateTab('unified-tab-a2')
    expect(dismissedPaneKeys()).toEqual([[`tab-a2:${LEAF_1}`, `tab-a2:${LEAF_2}`]])
  })

  it('no-op keystrokes and pointerdowns write nothing and send no dismiss', () => {
    const { store } = createAttentionStore()
    const pane = addLiveTerminalTab(store, WS_A, 'tab-a1')
    store.getState().setActiveWorktree(WS_A)
    const before = store.getState()

    for (let i = 0; i < 20; i += 1) {
      typeInPane(store, pane)
      pointerDownInTab(store, { ...pane, paneKey: null })
    }
    expect(store.getState()).toBe(before)
    expect(dismiss).not.toHaveBeenCalled()
  })
})

describe('the flag follows its markers', () => {
  it('a restart flag with no marker is read when its workspace comes on screen', () => {
    const { store, persists } = createAttentionStore({ windowOnScreen: false })
    store.setState({
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WS_A, repoId: 'repo1', path: '/path/a', isUnread: true })]
      }
    })
    addLiveTerminalTab(store, WS_A, 'tab-a1')
    store.getState().setActiveWorktree(WS_A)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:0 sortEpoch=0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
      ]
    `)

    setWindowOnScreen(store, true)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 sortEpoch=0",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":false}",
      ]
    `)
  })

  it('Mark as unread on the workspace on screen survives input until the screen moves', () => {
    const { store, persists } = createAttentionStore()
    const first = addLiveTerminalTab(store, WS_A, 'tab-a1')
    addLiveTerminalTab(store, WS_A, 'tab-a2', LEAF_2)
    store.getState().setActiveWorktree(WS_A)
    observe(store, persists)

    toggleUnreadByUser(store, store.getState().worktreesByRepo.repo1[0]!)
    typeInPane(store, first)
    pointerDownInTab(store, { ...first, paneKey: null })
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:0 b@local:read:0 sortEpoch=1",
        "tabs -",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
        "persist worktree a {"isUnread":true} host=local",
      ]
    `)

    store.getState().activateTab('unified-tab-a1')
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 sortEpoch=1",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":false}",
      ]
    `)
  })

  it('Mark as read removes every marker in the workspace and dismisses their panes', () => {
    const { store, persists } = createAttentionStore({ experimental: true })
    const first = addLiveTerminalTab(store, WS_A, 'tab-a1')
    const second = addLiveTerminalTab(store, WS_A, 'tab-a2', LEAF_2)
    ringBell(store, first)
    completeAgentTurn(store, second)
    observe(store, persists)

    toggleUnreadByUser(store, store.getState().worktreesByRepo.repo1[0]!)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:1000 b@local:read:0 sortEpoch=2",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":false} host=local",
      ]
    `)
    expect(dismissedPaneKeys()).toEqual([[first.paneKey, second.paneKey]])
  })

  it('closing an unmarked tab keeps a manual unread; closing a marked one dismisses its panes', () => {
    const { store, persists } = createAttentionStore()
    const marked = addLiveTerminalTab(store, WS_A, 'tab-a1')
    const unmarked = addLiveTerminalTab(store, WS_A, 'tab-a2', LEAF_2)
    toggleUnreadByUser(store, store.getState().worktreesByRepo.repo1[0]!)
    observe(store, persists)

    store.getState().closeTab(unmarked.tabId)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:UNREAD:0 b@local:read:0 sortEpoch=1",
        "tabs -",
        "panes -",
        "completions -",
        "dock=1 floatingDot=false",
      ]
    `)
    expect(dismiss).not.toHaveBeenCalled()

    ringBell(store, marked)
    store.getState().closeTab(marked.tabId)
    expect(observe(store, persists)).toMatchInlineSnapshot(`
      [
        "rows a@local:read:0 b@local:read:0 sortEpoch=1",
        "tabs -",
        "panes -",
        "completions -",
        "dock=0 floatingDot=false",
        "persist worktree a {"isUnread":false}",
      ]
    `)
    expect(dismissedPaneKeys()).toEqual([[marked.paneKey]])
  })
})
