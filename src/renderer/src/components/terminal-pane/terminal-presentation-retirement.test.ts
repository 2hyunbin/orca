// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTerminalTab } from '@/store/slices/worktrees-slice-test-fixtures'
import { captureTerminalSurfaceIdentity } from '../../../../shared/terminal-tab-close'
import { retireTerminalPresentation } from './terminal-presentation-retirement'
import { capturedPanesByTabId, parkedWatchersByTabId } from './terminal-parked-watcher-registry'
import { LEAF, SIBLING, mountedOwner } from './terminal-presentation-retirement.test-fixture'
import {
  createHarness,
  WORKTREE_ID,
  TAB_ID,
  LEAF_ID,
  PTY_ID,
  INCARNATION_ID
} from '../../../../main/runtime/__fixtures__/orca-runtime-terminal-close-continuity-fixtures'
import { hasRegisteredRuntimeTerminalTab } from '@/runtime/mounted-terminal-tab-registry'

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))

function prepare(split: boolean) {
  useAppStore.setState({
    tabsByWorktree: { 'wt-1': [makeTerminalTab({ id: 'terminal', worktreeId: 'wt-1' })] },
    terminalLayoutsByTabId: {
      terminal: {
        root: split
          ? {
              type: 'split',
              direction: 'horizontal',
              ratio: 0.7,
              first: { type: 'leaf', leafId: LEAF },
              second: { type: 'leaf', leafId: SIBLING }
            }
          : { type: 'leaf', leafId: LEAF },
        activeLeafId: split ? SIBLING : LEAF,
        expandedLeafId: split ? SIBLING : null,
        chatLeafId: LEAF,
        ptyIdsByLeafId: { [LEAF]: 'pty-1', ...(split ? { [SIBLING]: 'pty-2' } : {}) }
      }
    }
  })
  useAppStore
    .getState()
    .createUnifiedTab('wt-1', 'terminal', { id: 'terminal', entityId: 'terminal' })
  const identity = captureTerminalSurfaceIdentity(useAppStore.getState(), 'wt-1', 'terminal', LEAF)
  if (!identity) {
    throw new Error('Expected source identity')
  }
  return identity
}

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState(useAppStore.getInitialState(), true)
  capturedPanesByTabId.clear()
  parkedWatchersByTabId.clear()
})

describe('direct permanent presentation owner', () => {
  it.each([true, false])(
    'disposes mounted resources and canonical membership (split=%s)',
    (split) => {
      const identity = prepare(split)
      const owner = mountedOwner(split)
      capturedPanesByTabId.set('terminal', {
        worktreeId: 'wt-1',
        panes: [{ paneId: 1, leafId: LEAF, ptyId: 'pty-1', drivesTabTitle: true }]
      })
      try {
        retireTerminalPresentation(identity)
        expect(owner.source.terminal.dispose).toHaveBeenCalledOnce()
        expect(owner.source.searchAddon.dispose).toHaveBeenCalledOnce()
        expect(owner.sourceTransport.detach).toHaveBeenCalledExactlyOnceWith({
          preserveExitObserver: false
        })
        expect(owner.sourceTransport.destroy).not.toHaveBeenCalled()
        expect(owner.transports.has(1)).toBe(false)
        expect(owner.bindings.has(1)).toBe(false)
        expect(capturedPanesByTabId.has('terminal')).toBe(false)
        expect(owner.binding.dispose).toHaveBeenCalledOnce()
        expect(owner.link.dispose).toHaveBeenCalledOnce()
        expect(owner.panes.has(1)).toBe(false)
        expect(owner.setPaneCount).toHaveBeenLastCalledWith(split ? 1 : 0)
        const state = useAppStore.getState()
        if (split) {
          expect(owner.other.terminal.dispose).not.toHaveBeenCalled()
          expect(state.terminalLayoutsByTabId.terminal).toMatchObject({
            root: { type: 'leaf', leafId: SIBLING },
            activeLeafId: SIBLING,
            expandedLeafId: SIBLING,
            ptyIdsByLeafId: { [SIBLING]: 'pty-2' }
          })
          expect(state.terminalLayoutsByTabId.terminal.chatLeafId).toBeUndefined()
        } else {
          expect(owner.manager.destroy).toHaveBeenCalledOnce()
          expect(owner.cancelResize).toHaveBeenCalledOnce()
          expect(owner.expandedElement.style.display).toBe('flex')
          expect(capturedPanesByTabId.has('terminal')).toBe(false)
          expect(owner.onLayoutChanged).not.toHaveBeenCalled()
          expect(hasRegisteredRuntimeTerminalTab('terminal', 'wt-1')).toBe(false)
          expect(state.tabsByWorktree['wt-1']).toEqual([])
          expect(state.terminalLayoutsByTabId.terminal).toBeUndefined()
        }
      } finally {
        owner.unregister()
      }
    }
  )

  it.each([true, false])(
    'disposes exact parked captures, including empty watcher entries (split=%s)',
    (split) => {
      const identity = prepare(split)
      const dispose = vi.fn()
      const siblingDispose = vi.fn()
      capturedPanesByTabId.set('terminal', {
        worktreeId: 'wt-1',
        panes: [
          { paneId: 1, leafId: LEAF, ptyId: 'pty-1', drivesTabTitle: true },
          ...(split ? [{ paneId: 2, leafId: SIBLING, ptyId: 'pty-2', drivesTabTitle: false }] : [])
        ]
      })
      parkedWatchersByTabId.set('terminal', {
        worktreeId: 'wt-1',
        tabPtyId: 'pty-1',
        paneIdByPtyId: new Map([['pty-1', 1], ...(split ? [['pty-2', 2] as const] : [])]),
        disposersByPtyId: new Map(
          split
            ? [
                ['pty-1', dispose],
                ['pty-2', siblingDispose]
              ]
            : []
        )
      })
      retireTerminalPresentation(identity)
      expect(siblingDispose).not.toHaveBeenCalled()
      if (split) {
        expect(dispose).toHaveBeenCalledOnce()
        expect(capturedPanesByTabId.get('terminal')?.panes.map((pane) => pane.leafId)).toEqual([
          SIBLING
        ])
        expect([...parkedWatchersByTabId.get('terminal')!.paneIdByPtyId.keys()]).toEqual(['pty-2'])
      } else {
        expect(capturedPanesByTabId.has('terminal')).toBe(false)
        expect(parkedWatchersByTabId.has('terminal')).toBe(false)
      }
    }
  )

  it('completes host stop, direct mounted disposal and explicit durable intent together', async () => {
    const harness = createHarness({ registerPtyBacked: true, publishMobileSurface: true })
    const session = harness.getSession()
    useAppStore.setState({
      tabsByWorktree: session.tabsByWorktree,
      terminalLayoutsByTabId: session.terminalLayoutsByTabId
    })
    useAppStore
      .getState()
      .createUnifiedTab(WORKTREE_ID, 'terminal', { id: TAB_ID, entityId: TAB_ID })
    const source = harness.runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_ID}`, WORKTREE_ID)
    if (!source.presentation) {
      throw new Error('Expected original presentation')
    }
    const owner = mountedOwner(false, {
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      ptyId: PTY_ID
    })
    harness.setVerifiedStopResult(true)
    harness.setStopAndWaitAction(async () => {
      await harness.runtime.onPtyExit(PTY_ID, 0, INCARNATION_ID, { hostExitConfirmed: true })
      expect(owner.source.terminal.dispose).not.toHaveBeenCalled()
      expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    })
    harness.setCloseTerminalTabAction(() =>
      retireTerminalPresentation(source.presentation!.identity)
    )
    try {
      await expect(
        harness.runtime.closeTerminal(source.handle, source.incarnationId, source.presentation)
      ).resolves.toMatchObject({ ptyKilled: true })
      expect(owner.source.terminal.dispose).toHaveBeenCalledOnce()
      expect(owner.transports.size).toBe(0)
      expect(owner.bindings.size).toBe(0)
      expect(owner.sourceTransport.destroy).not.toHaveBeenCalled()
      expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
      expect(harness.getSession().closedTerminalTabTombstonesByTabId?.[TAB_ID]).toBeDefined()
      expect(harness.flushOrThrow).toHaveBeenCalled()
      expect(harness.kill).not.toHaveBeenCalled()
    } finally {
      owner.unregister()
    }
  })

  it('refuses a replacement or a newly pinned final tab before disposal', () => {
    const identity = prepare(false)
    const owner = mountedOwner(false)
    try {
      useAppStore.setState({
        terminalLayoutsByTabId: {
          terminal: {
            ...useAppStore.getState().terminalLayoutsByTabId.terminal,
            ptyIdsByLeafId: { [LEAF]: 'replacement' }
          }
        }
      })
      expect(() => retireTerminalPresentation(identity)).toThrow('terminal_pane_owner_changed')
      expect(owner.source.terminal.dispose).not.toHaveBeenCalled()
      useAppStore.setState({
        terminalLayoutsByTabId: {
          terminal: {
            ...useAppStore.getState().terminalLayoutsByTabId.terminal,
            ptyIdsByLeafId: { [LEAF]: 'pty-1' }
          }
        },
        tabsByWorktree: {
          'wt-1': [{ ...useAppStore.getState().tabsByWorktree['wt-1'][0], isPinned: true }]
        }
      })
      expect(() => retireTerminalPresentation(identity)).toThrow('terminal_tab_pinned')
      expect(owner.source.terminal.dispose).not.toHaveBeenCalled()
    } finally {
      owner.unregister()
    }
  })

  it('reports a real disposer failure and retains source membership', () => {
    const identity = prepare(false)
    const owner = mountedOwner(false)
    owner.source.paneDragCleanup = () => {
      throw new Error('disposal failed')
    }
    try {
      expect(() => retireTerminalPresentation(identity)).toThrow('disposal failed')
      expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
      expect(owner.sourceTransport.destroy).not.toHaveBeenCalled()
    } finally {
      owner.unregister()
    }
  })
})
