import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { recordLayoutApply, sendLayoutApply } from '@/runtime/layout-apply-send'

export type BootstrapSplitManager = Pick<
  PaneManager,
  'getActivePane' | 'getPanes' | 'setActivePane' | 'splitPane'
>

/**
 * The manager a tab's startup splits use in a layout-owner build: each split is drawn at once
 * under the window's pane id (its startup command rides on the split), then recorded in main.
 */
export function recordingBootstrapSplits(
  manager: PaneManager,
  worktreeId: string,
  tabId: string
): BootstrapSplitManager {
  return {
    getActivePane: () => manager.getActivePane(),
    getPanes: () => manager.getPanes(),
    setActivePane: (paneId, opts) => manager.setActivePane(paneId, opts),
    splitPane: (paneId, direction, options) => {
      const sourceLeafId = manager.getLeafId(paneId)
      const created = manager.splitPane(paneId, direction, options)
      if (created && sourceLeafId) {
        recordDrawnPaneSplit(worktreeId, tabId, sourceLeafId, direction, created.leafId)
      }
      return created
    }
  }
}

/**
 * Records a split the window drew under its pane id; main writes it, or finds the pane it already
 * holds and changes nothing.
 */
export function recordDrawnPaneSplit(
  worktreeId: string,
  tabId: string,
  sourceLeafId: string,
  direction: 'vertical' | 'horizontal',
  newLeafId: string
): void {
  recordLayoutApply(useAppStore.getState(), worktreeId, {
    type: 'splitPane',
    tabId,
    leafId: sourceLeafId,
    direction,
    newLeafId
  })
}

/**
 * Records a split main asked for, once the window mounted it. Main writes it again only if it took
 * it back while the window mounted it late; a pane a client closed meanwhile stays closed, and
 * `gone` removes the window's copy.
 */
export function recordMountedMainSplit(
  worktreeId: string,
  split: {
    tabId: string
    sourceLeafId: string
    direction: 'vertical' | 'horizontal'
    newLeafId: string
  },
  gone: () => void
): void {
  const keep = (): void => {}
  sendLayoutApply(
    useAppStore.getState(),
    worktreeId,
    {
      type: 'splitPane',
      tabId: split.tabId,
      leafId: split.sourceLeafId,
      direction: split.direction,
      newLeafId: split.newLeafId,
      mainAsked: true
    },
    { apply: keep, asToday: keep, refused: (code) => code === 'pane_closed' && gone() }
  )
}
