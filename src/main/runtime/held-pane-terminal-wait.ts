// Waits for a held pane's start to end: the terminal it binds, or null once it ends any other way.

import type { PublishedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-published'
import type { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'

export type HeldPane = { workspace: string; tabId: string; leafId: string }

function paneOf(layout: PublishedWorkspaceLayout | undefined, pane: HeldPane) {
  return layout?.tabs
    .flatMap((tab) => (tab.entityId === pane.tabId ? (tab.terminal?.panes ?? []) : []))
    .find((candidate) => candidate.leafId === pane.leafId)
}

function settled(published: ReturnType<typeof paneOf>): string | null | undefined {
  if (!published) {
    return null
  }
  if (published.status === 'running' && published.ptyId) {
    return published.ptyId
  }
  return published.status === 'starting' || published.status === 'restorable' ? undefined : null
}

/**
 * `begin` asks the holder for the start (false when it refused). A pane that already settled
 * answers at once, without asking.
 */
export async function waitForHeldPaneTerminal(
  holder: RuntimeWorkspaceLayouts,
  pane: HeldPane,
  begin: () => boolean,
  options: { signal?: AbortSignal; askFirst?: boolean } = {}
): Promise<string | null> {
  const { signal } = options
  if (signal?.aborted) {
    return null
  }
  const now = options.askFirst ? undefined : settled(paneOf(holder.published(pane.workspace), pane))
  if (now !== undefined) {
    return now
  }
  return await new Promise<string | null>((resolve) => {
    const finish = (ptyId: string | null): void => {
      unsubscribe()
      signal?.removeEventListener('abort', onAbort)
      resolve(ptyId)
    }
    const onAbort = (): void => finish(null)
    const { unsubscribe } = holder.subscribe((event) => {
      if (event.key !== pane.workspace) {
        return
      }
      const result = settled(event.type === 'workspace' ? paneOf(event.layout, pane) : undefined)
      if (result !== undefined) {
        finish(result)
      }
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (!begin()) {
      finish(null)
    }
  })
}
