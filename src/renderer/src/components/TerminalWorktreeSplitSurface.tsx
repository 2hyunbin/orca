import React from 'react'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import type { ActivityTerminalPortalTarget } from './activity/activity-terminal-portal'
import {
  useBrowserGuestPaintRetention,
  useWorktreeBrowserPageIds
} from './browser-pane/host-guest/browser-guest-paint-retention'
import {
  shouldKeepHiddenWorktreeSurfacePaintable,
  shouldMountRetainedBrowserOverlay
} from './browser-pane/host-guest/browser-worktree-surface-paintability'
import TabGroupSplitLayout from './tab-group/TabGroupSplitLayout'
import { WorkspacePaneOverlayLayers } from './WorkspacePaneOverlayLayers'

export const WorktreeSplitSurface = React.memo(function WorktreeSplitSurface({
  worktreeId,
  worktreePath,
  layout,
  focusedGroupId,
  isVisible,
  revealHold,
  shouldMeasureHiddenWorktree,
  shouldColdParkTerminalPanes,
  isForceParked,
  activityTerminalPortals,
  backgroundMountTabIds,
  activationDeferredMountTabIds
}: {
  worktreeId: string
  worktreePath: string
  layout: TabGroupLayoutNode
  focusedGroupId?: string
  isVisible: boolean
  /** While a parked reveal remounts: the outgoing surface stays painted, the incoming one lays out unseen. */
  revealHold?: 'outgoing' | 'incoming'
  shouldMeasureHiddenWorktree: boolean
  shouldColdParkTerminalPanes: boolean
  isForceParked: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  backgroundMountTabIds: ReadonlySet<string> | null
  activationDeferredMountTabIds: ReadonlySet<string> | null
}): React.JSX.Element {
  // Why: the outgoing workspace keeps its renderers painted during a hold; inert keeps input off it.
  const isRendered = isVisible || revealHold === 'outgoing'
  const browserPageIds = useWorktreeBrowserPageIds(worktreeId)
  const needsBrowserGuestPaint = useBrowserGuestPaintRetention(browserPageIds)
  const shouldKeepPaintable = shouldKeepHiddenWorktreeSurfacePaintable({
    shouldMeasureHiddenWorktree,
    needsBrowserGuestPaint
  })

  return (
    <div
      className={
        revealHold === 'incoming'
          ? 'absolute inset-0 flex opacity-0 pointer-events-none'
          : isRendered
            ? 'absolute inset-0 flex'
            : shouldKeepPaintable
              ? 'absolute inset-0 flex opacity-0 pointer-events-none'
              : 'absolute inset-0 hidden'
      }
      inert={!isVisible}
      aria-hidden={!isVisible}
    >
      <TabGroupSplitLayout
        layout={layout}
        worktreeId={worktreeId}
        focusedGroupId={focusedGroupId}
        isWorktreeActive={isRendered}
      />
      <WorkspacePaneOverlayLayers
        worktreeId={worktreeId}
        worktreePath={worktreePath}
        isVisible={isRendered}
        ownsNativeChatToggleShortcut={isVisible}
        shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
        shouldColdParkTerminalPanes={shouldColdParkTerminalPanes}
        isForceParked={isForceParked}
        activityTerminalPortals={activityTerminalPortals}
        backgroundMountTabIds={backgroundMountTabIds}
        activationDeferredMountTabIds={activationDeferredMountTabIds}
        mountRetainedBrowserOverlay={shouldMountRetainedBrowserOverlay({
          isWorktreeVisible: isVisible,
          hasDeferredBackgroundMounts: backgroundMountTabIds !== null,
          needsBrowserGuestPaint
        })}
        mountEmulatorOverlay={isVisible || backgroundMountTabIds === null}
      />
    </div>
  )
})
