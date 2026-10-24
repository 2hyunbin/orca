import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { useAppStore } from '../store'

/** Long enough for a seeded tab's first spawn to publish; the user sees no pane until then. */
const HOST_SPLIT_SOURCE_WAIT_MS = 15_000

type SplitSourcePane = { worktreeId: string; tabId: string; leafId: string }

/** The terminal the host published for a pane of one of its tabs, before this pane's own attach lands. */
export function readHostPublishedSplitSourcePtyId(source: SplitSourcePane): string | null {
  if (!isWebTerminalSurfaceTabId(source.tabId)) {
    return null
  }
  return (
    useAppStore.getState().terminalLayoutsByTabId[source.tabId]?.ptyIdsByLeafId?.[source.leafId] ??
    null
  )
}

/**
 * Waits for the host to publish the source pane's terminal. Null once the tab is gone or the wait
 * runs out: a pane of a host tab that splits here gets no terminal, since only the host starts one.
 */
export function waitForHostPublishedSplitSourcePtyId(
  source: SplitSourcePane,
  timeoutMs = HOST_SPLIT_SOURCE_WAIT_MS
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (ptyId: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve(ptyId)
    }
    const check = (): void => {
      const ptyId = readHostPublishedSplitSourcePtyId(source)
      if (ptyId) {
        settle(ptyId)
      } else if (
        !(useAppStore.getState().tabsByWorktree[source.worktreeId] ?? []).some(
          (tab) => tab.id === source.tabId
        )
      ) {
        settle(null)
      }
    }
    const timer = setTimeout(() => settle(null), timeoutMs)
    const unsubscribe = useAppStore.subscribe(check)
    check()
  })
}
