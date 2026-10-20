// This machine's chat listing in a layout-owner build: main places and removes a listed chat's tab
// in its own layout, and its frames draw it, so the listing changes no tab-bar structure of a
// workspace frames draw. It still updates what a drawn chat tab shows (its label from the host).

import type { Tab } from '../../../../shared/tab-types'
import type { AppState } from '@/store/types'
import { framesDrawWorkspace } from '../workspace-layout-frame-drawn-workspaces'

type ChatTabSlices = Pick<
  AppState,
  'unifiedTabsByWorktree' | 'groupsByWorktree' | 'layoutByWorktree' | 'activeGroupIdByWorktree'
>

/** `after` with the structure of every workspace frames draw back as `before` had it. */
export function withFrameDrawnChatStructure<State extends ChatTabSlices>(
  before: AppState,
  after: State,
  worktreeIds: readonly string[]
): State {
  const drawn = framesDrawWorkspace(before)
  const keys = [...new Set(worktreeIds)].filter(drawn)
  if (keys.length === 0) {
    return after
  }
  const restore = <T>(slice: Record<string, T>, own: Record<string, T>): Record<string, T> => {
    const next = { ...slice }
    for (const key of keys) {
      if (key in own) {
        next[key] = own[key]!
      } else {
        delete next[key]
      }
    }
    return next
  }
  const unifiedTabsByWorktree = { ...after.unifiedTabsByWorktree }
  for (const key of keys) {
    const listed = new Map((after.unifiedTabsByWorktree[key] ?? []).map((tab) => [tab.id, tab]))
    const kept = (before.unifiedTabsByWorktree[key] ?? []).map((tab): Tab => {
      const shown = listed.get(tab.id)
      return shown && tab.contentType === 'agent-session' && shown.label !== tab.label
        ? { ...tab, label: shown.label }
        : tab
    })
    if (key in before.unifiedTabsByWorktree) {
      unifiedTabsByWorktree[key] = kept
    } else {
      delete unifiedTabsByWorktree[key]
    }
  }
  return {
    ...after,
    unifiedTabsByWorktree,
    groupsByWorktree: restore(after.groupsByWorktree, before.groupsByWorktree),
    layoutByWorktree: restore(after.layoutByWorktree, before.layoutByWorktree),
    activeGroupIdByWorktree: restore(after.activeGroupIdByWorktree, before.activeGroupIdByWorktree)
  }
}
