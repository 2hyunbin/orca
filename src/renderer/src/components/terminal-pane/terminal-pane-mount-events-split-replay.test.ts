// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyConnectionDeps } from './pty-connection-types'
import { installTerminalPaneMountEvents } from './terminal-pane-mount-events'
import {
  _resetTerminalPaneSplitRequestRoutingForTests,
  dispatchTerminalPaneSplitRequest
} from './terminal-pane-split-request-routing'

const storeState = vi.hoisted(() => ({ recordFeatureInteraction: () => {} }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))

const SOURCE = '11111111-1111-4111-8111-111111111111'
const NEW = '22222222-2222-4222-8222-222222222222'

function mountedTab(): {
  manager: PaneManager
  splitPane: ReturnType<typeof vi.fn>
  closeNew: () => void
} {
  const leafById = new Map<number, string>([[1, SOURCE]])
  const splitPane = vi.fn((_paneId: number, _direction: string, opts?: { leafId?: string }) => {
    const leafId = opts?.leafId ?? 'window-minted'
    leafById.set(2, leafId)
    return { id: 2, leafId }
  })
  const manager = {
    splitPane,
    getLeafId: (paneId: number) => leafById.get(paneId) ?? null,
    getNumericIdForLeaf: (leafId: string) =>
      [...leafById].find(([, id]) => id === leafId)?.[0] ?? null
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the split handler calls only these manager methods.
    manager: manager as unknown as PaneManager,
    splitPane,
    closeNew: () => leafById.delete(2)
  }
}

function install(manager: PaneManager): () => void {
  return installTerminalPaneMountEvents({
    manager,
    deps: {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      managerRef: { current: manager },
      showPaneTitle: vi.fn(),
      persistLayoutSnapshot: vi.fn(),
      syncCanExpandState: vi.fn(),
      queueResizeAll: vi.fn()
    },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a split reads only `startup` from pty deps.
    ptyDeps: {} as PtyConnectionDeps
  })
}

const SPLIT = {
  tabId: 'tab-1',
  worktreeId: 'wt-1',
  paneRuntimeId: 1,
  sourceLeafId: SOURCE,
  direction: 'vertical' as const,
  command: 'agent --task 1',
  newLeafId: NEW
}

describe('a split main re-sends after its CLI wait timed out (#32169)', () => {
  afterEach(() => {
    _resetTerminalPaneSplitRequestRoutingForTests()
  })

  // Main re-sends only while its graph never listed the pane, which a quick close can also cause.
  it('does not re-make, or re-run the command of, a pane it made and the user closed', () => {
    const { manager, splitPane, closeNew } = mountedTab()
    const uninstall = install(manager)

    dispatchTerminalPaneSplitRequest(SPLIT)
    closeNew()
    dispatchTerminalPaneSplitRequest(SPLIT)

    expect(splitPane).toHaveBeenCalledTimes(1)
    uninstall()
  })
})
