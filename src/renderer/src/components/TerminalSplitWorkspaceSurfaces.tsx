import { useAnyBrowserGuestNeedsPaint } from './browser-pane/host-guest/browser-guest-paint-retention'
import { WorktreeSplitSurface } from './TerminalWorktreeSplitSurface'
import { selectParkedEquivalentMountTabIds } from './terminal/startup-terminal-tab-hold'
import type { TerminalController } from './use-terminal-controller'
import { useParkedRevealHold } from './terminal/use-parked-reveal-hold'

export function TerminalSplitWorkspaceSurfaces({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element | null {
  const {
    activationDeferredMountTabIdsByWorktreeRef,
    activeGroupIdByWorktree,
    activeView,
    activityTerminalPortals,
    anyMountedWorktreeHasLayout,
    backgroundMountTabIdsByWorktreeRef,
    effectiveActiveLayout,
    effectiveParkedTerminalWorktreeIds,
    forceParkedTerminalWorktreeIds,
    getEffectiveLayoutForWorktree,
    measurableBackgroundWorktreeIdsRef,
    mountedWorktreeIdsRef,
    renderedActiveWorktreeId,
    startupTerminalTabHold,
    workspaceSurfaces
  } = controller
  // Why: this and TerminalSurface are both strict ancestors of every browser <webview>, so a
  // remote controller needs each to drop `hidden` — the per-worktree surface hatch below cannot
  // override an ancestor that stopped compositing.
  const retainBrowserGuestPaint = useAnyBrowserGuestNeedsPaint(!effectiveActiveLayout)
  const { hold, releaseHold } = useParkedRevealHold({
    selectedWorktreeId: activeView === 'terminal' ? renderedActiveWorktreeId : null,
    parkedWorktreeIds: effectiveParkedTerminalWorktreeIds,
    mountedWorktreeIds: mountedWorktreeIdsRef.current
  })
  if (!anyMountedWorktreeHasLayout) {
    return null
  }
  return (
    <div
      // Why: input belongs to the selected workspace, so it ends any hold on the outgoing one.
      onKeyDownCapture={hold ? releaseHold : undefined}
      onPointerDownCapture={hold ? releaseHold : undefined}
      onWheelCapture={hold ? releaseHold : undefined}
      className={`relative flex flex-1 min-w-0 min-h-0 overflow-hidden${
        effectiveActiveLayout
          ? ''
          : retainBrowserGuestPaint
            ? ' opacity-0 pointer-events-none'
            : ' hidden'
      }`}
    >
      {workspaceSurfaces
        .filter((workspace) => mountedWorktreeIdsRef.current.has(workspace.id))
        .map((workspace) => {
          const layout = getEffectiveLayoutForWorktree(workspace.id)
          if (!layout) {
            return null
          }
          const isVisible = activeView === 'terminal' && workspace.id === renderedActiveWorktreeId
          const shouldMeasureHiddenWorktree =
            !isVisible && measurableBackgroundWorktreeIdsRef.current.has(workspace.id)
          const shouldColdParkTerminalPanes =
            !isVisible &&
            !shouldMeasureHiddenWorktree &&
            effectiveParkedTerminalWorktreeIds.has(workspace.id)
          return (
            <WorktreeSplitSurface
              key={`tab-groups-${workspace.id}`}
              worktreeId={workspace.id}
              worktreePath={workspace.path}
              layout={layout}
              focusedGroupId={activeGroupIdByWorktree[workspace.id]}
              isVisible={isVisible}
              revealHold={
                hold?.from === workspace.id
                  ? 'outgoing'
                  : hold?.to === workspace.id
                    ? 'incoming'
                    : undefined
              }
              shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
              shouldColdParkTerminalPanes={shouldColdParkTerminalPanes}
              isForceParked={forceParkedTerminalWorktreeIds.has(workspace.id)}
              activityTerminalPortals={activityTerminalPortals}
              backgroundMountTabIds={
                backgroundMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null
              }
              activationDeferredMountTabIds={selectParkedEquivalentMountTabIds(
                activationDeferredMountTabIdsByWorktreeRef.current.get(workspace.id),
                startupTerminalTabHold,
                workspace.id
              )}
            />
          )
        })}
    </div>
  )
}
