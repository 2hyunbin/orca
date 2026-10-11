import { describe, expect, it } from 'vitest'
import { emptyModel, WS } from './workspace-layout-command.test-fixture'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import { followTabClosesInView } from './workspace-layout-view-tab-closes'
import { emptyLayoutViewRecord, type LayoutViewRecord } from './workspace-layout-views'

/** One group of content tabs in this order. */
function model(tabOrder: string[]): WorkspaceLayoutModel {
  return {
    ...emptyModel(),
    workspaces: {
      [WS]: {
        worktreeId: WS,
        groups: [{ id: 'g', tabOrder }],
        tabs: tabOrder.map((id) => ({
          id,
          entityId: id,
          createdAt: 1,
          customTitle: null,
          color: null,
          kind: 'browser' as const
        }))
      }
    }
  }
}

function shown(activeTabId: string, recentTabIds?: string[]): LayoutViewRecord {
  return {
    ...emptyLayoutViewRecord(),
    groups: { [WS]: { g: { activeTabId, ...(recentTabIds ? { recentTabIds } : {}) } } }
  }
}

function afterClose(record: LayoutViewRecord, before: string[], after: string[]) {
  return followTabClosesInView(record, model(before), model(after)).groups[WS]?.g
}

describe('followTabClosesInView', () => {
  it("shows the closed tab's right neighbour when no other tab was visited, as today", () => {
    // Restored groups seed the recent list with the shown tab only.
    expect(afterClose(shown('t2', ['t2']), ['t1', 't2', 't3'], ['t1', 't3'])).toEqual({
      activeTabId: 't3',
      recentTabIds: []
    })
  })

  it('shows the left neighbour when the closed tab was last', () => {
    expect(afterClose(shown('t3'), ['t1', 't2', 't3'], ['t1', 't2'])?.activeTabId).toBe('t2')
  })

  it('shows the most recently visited remaining tab first', () => {
    expect(
      afterClose(shown('t2', ['t1', 't3', 't2']), ['t1', 't2', 't3', 't4'], ['t1', 't3', 't4'])
    ).toEqual({ activeTabId: 't3', recentTabIds: ['t1', 't3'] })
  })

  it('skips neighbours closed in the same change', () => {
    expect(afterClose(shown('t2'), ['t1', 't2', 't3', 't4'], ['t1', 't4'])?.activeTabId).toBe('t4')
  })

  it('leaves a record whose shown tab stayed, or whose group went, unchanged', () => {
    const record = shown('t1')

    expect(followTabClosesInView(record, model(['t1', 't2']), model(['t1']))).toBe(record)
    expect(followTabClosesInView(shown('t2'), model(['t2']), emptyModel()).groups[WS]?.g).toEqual({
      activeTabId: 't2'
    })
  })
})
