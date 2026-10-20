// The window's frame-apply check for one test's life: after every flush, the store must show what
// the full build (the window's view and facts read back through its save and the Loader) shows
// for the same cache and the store as the flush found it. Mirrors main's model check.

import { stableJson } from '../../../shared/workspace-layout/workspace-layout-load-report'
import { isDrawnGroupLayoutHeld, isDrawnTabHeld } from './layout-owner-drawn-tab-holds'
import { isTabPaneTreeHeld } from './layout-owner-pane-intents'
import {
  observeLayoutFrameApply,
  type LayoutFrameApplyObservation
} from './workspace-layout-frame-apply-observer'
import { fullLayoutFrameBuildPatch } from './workspace-layout-frame-builds'
import type { LayoutFrameSlices } from '@/store/workspace-layout-frame-slices'

const FRAME_SLICES: readonly (keyof LayoutFrameSlices)[] = [
  'tabsByWorktree',
  'terminalLayoutsByTabId',
  'activeTabIdByWorktree',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'activeGroupIdByWorktree',
  'layoutByWorktree',
  'openFiles',
  'editorDrafts',
  'markdownFrontmatterVisible',
  'activeFileIdByWorktree',
  'browserTabsByWorktree',
  'browserPagesByWorkspace',
  'remoteBrowserPageHandlesByPageId',
  'activeBrowserTabIdByWorktree',
  'activeTabTypeByWorktree'
]

/**
 * Empty when the flush left the store as the full build of its workspaces leaves it. A flush that
 * built in full ran the reference itself (and a second run mints other ids for a new page).
 */
export function layoutFrameApplyErrors({
  before,
  after,
  cache,
  changed,
  fullBuilt,
  rowFieldsTaken
}: LayoutFrameApplyObservation): string[] {
  const keys = changed.filter((key) => key in cache)
  if (keys.length === 0 || fullBuilt.length > 0) {
    return []
  }
  const expected: Record<string, unknown> = {
    ...before,
    ...fullLayoutFrameBuildPatch(before, cache, keys, {
      keepsTerminalLayout: isTabPaneTreeHeld,
      newRowFields: (tabId) => rowFieldsTaken.get(tabId) ?? null,
      held: { isTabHeld: isDrawnTabHeld, isGroupLayoutHeld: isDrawnGroupLayoutHeld }
    })
  }
  const shown: Record<string, unknown> = { ...after }
  return FRAME_SLICES.flatMap((slice) =>
    stableJson(shown[slice]) === stableJson(expected[slice])
      ? []
      : [firstDifference(slice, shown[slice], expected[slice])]
  )
}

/** For a shared transport with no test of its own to report to: the flush itself fails. */
export function throwLayoutFrameApplyErrors(observation: LayoutFrameApplyObservation): void {
  const errors = layoutFrameApplyErrors(observation)
  if (errors.length > 0) {
    throw new Error(`layout frame apply differs from the full build:\n${errors.join('\n')}`)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The first path where the store and the full build differ, with both values there. */
function firstDifference(path: string, shown: unknown, built: unknown): string {
  if (isObject(shown) && isObject(built)) {
    for (const key of new Set([...Object.keys(shown), ...Object.keys(built)])) {
      if (stableJson(shown[key]) !== stableJson(built[key])) {
        return firstDifference(`${path}.${key}`, shown[key], built[key])
      }
    }
  }
  return `${path}: store ${stableJson(shown)} != full build ${stableJson(built)}`
}

export function installLayoutFrameApplyCheck(): {
  /** Every mismatch found, flush by flush. */
  failures: string[]
  /** Workspaces built in full and from the store's view, in flush order. */
  fullBuilt: string[]
  workspaceBuilt: string[]
  checked: () => number
  /** Forgets the builds so far, such as startup's. */
  forgetBuilds: () => void
  uninstall: () => void
} {
  const failures: string[] = []
  const fullBuilt: string[] = []
  const workspaceBuilt: string[] = []
  let checked = 0
  observeLayoutFrameApply((observation) => {
    checked += 1
    fullBuilt.push(...observation.fullBuilt)
    workspaceBuilt.push(...observation.workspaceBuilt)
    failures.push(...layoutFrameApplyErrors(observation))
  })
  return {
    failures,
    fullBuilt,
    workspaceBuilt,
    checked: () => checked,
    forgetBuilds: () => {
      fullBuilt.length = 0
      workspaceBuilt.length = 0
    },
    uninstall: () => observeLayoutFrameApply(null)
  }
}
