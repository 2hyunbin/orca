import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { layoutContainsLeafId } from '../../../shared/workspace-layout/terminal-pane-tree'
import { runtimeEnvironmentIdUnlessTwin } from '../lib/resolve-owner'
import { useAppStore } from '../store'
import { resolveWebSessionVisibleTabId } from './web-session-focus-intent'
import type { WebRuntimeSplitSource } from './web-runtime-split-focus'

/** Long enough for a seeded tab's first spawn to publish; the user sees no pane until then. */
const HOST_SPLIT_SOURCE_WAIT_MS = 15_000

type AppState = ReturnType<typeof useAppStore.getState>

/** The terminal the host published for a pane of one of its tabs, before this pane's own attach lands. */
export function readHostPublishedSplitSourcePtyId(source: WebRuntimeSplitSource): string | null {
  if (!isWebTerminalSurfaceTabId(source.tabId)) {
    return null
  }
  return (
    useAppStore.getState().terminalLayoutsByTabId[source.tabId]?.ptyIdsByLeafId?.[source.leafId] ??
    null
  )
}

/** A pane of a paired server's tab: only that server starts terminals in it. */
export function isHostTabPane(source: WebRuntimeSplitSource): boolean {
  return (
    isWebTerminalSurfaceTabId(source.tabId) &&
    runtimeEnvironmentIdUnlessTwin(useAppStore.getState(), source.worktreeId) !== null
  )
}

function viewOf(state: AppState): string {
  const worktreeId = state.activeWorktreeId ?? null
  const tabId = worktreeId ? resolveWebSessionVisibleTabId(state, worktreeId) : null
  const leafId = tabId ? (state.terminalLayoutsByTabId[tabId]?.activeLeafId ?? null) : null
  return JSON.stringify([worktreeId, tabId, leafId])
}

/** False once the source pane closed, its tab went, or its workspace left the paired server. */
function sourceStillThere(source: WebRuntimeSplitSource, environmentId: string | null): boolean {
  const state = useAppStore.getState()
  const root = state.terminalLayoutsByTabId[source.tabId]?.root
  return (
    runtimeEnvironmentIdUnlessTwin(state, source.worktreeId) === environmentId &&
    (state.tabsByWorktree[source.worktreeId] ?? []).some((tab) => tab.id === source.tabId) &&
    // A tab not yet laid out has no tree to have dropped the leaf from.
    (!root || layoutContainsLeafId(root, source.leafId))
  )
}

/**
 * Runs the split once the host publishes the source pane's terminal. `navigatedAway` is true when
 * the user moved elsewhere meanwhile, so the late split must not take focus back.
 */
export function splitWhenHostPublishesSource(
  source: WebRuntimeSplitSource,
  split: (ptyId: string, navigatedAway: boolean) => void,
  timeoutMs = HOST_SPLIT_SOURCE_WAIT_MS
): void {
  const gesture = useAppStore.getState()
  const environmentId = runtimeEnvironmentIdUnlessTwin(gesture, source.worktreeId)
  const gestureView = viewOf(gesture)
  let settled = false
  const finish = (): void => {
    settled = true
    clearTimeout(timer)
    unsubscribe()
  }
  const check = (): void => {
    if (settled) {
      return
    }
    const ptyId = readHostPublishedSplitSourcePtyId(source)
    if (ptyId) {
      finish()
      split(ptyId, viewOf(useAppStore.getState()) !== gestureView)
    } else if (!sourceStillThere(source, environmentId)) {
      finish()
    }
  }
  const timer = setTimeout(() => {
    finish()
    toast.error(
      translate(
        'auto.runtime.webRuntimeSession.splitSourceUnpublished',
        'The pane didn’t split: its terminal hasn’t started on the host yet.'
      )
    )
  }, timeoutMs)
  const unsubscribe = useAppStore.subscribe(check)
  check()
}
