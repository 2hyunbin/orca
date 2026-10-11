import type {
  RuntimeSyncedTab,
  RuntimeSyncWindowGraph,
  RuntimeRendererSyncWindowGraph
} from '../../../shared/runtime-types'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'
import type { RuntimeSessionWindowGraphHost } from './session-window-graph'

/** The runtime indexes graph tabs by bare id, so duplicate ids cannot be routed safely. */
function assertUniqueRuntimeGraphTabIds(tabs: readonly RuntimeSyncedTab[]): void {
  const seen = new Set<string>()
  for (const tab of tabs) {
    if (seen.has(tab.tabId)) {
      throw new Error('duplicate_runtime_tab_id')
    }
    seen.add(tab.tabId)
  }
}

export function prepareSessionGraphPublication(
  host: Pick<RuntimeSessionWindowGraphHost, 'state' | 'attachWindow'>,
  windowId: number,
  graph: RuntimeSyncWindowGraph | RuntimeRendererSyncWindowGraph
): string | null | undefined {
  assertUniqueRuntimeGraphTabIds(graph.tabs)
  if (
    windowId !== HEADLESS_RUNTIME_WINDOW_ID &&
    host.state.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID &&
    host.state.headlessGraphFallbackAvailable
  ) {
    if (windowId !== host.state.pendingHeadlessPromotionWindowId) {
      throw new Error('Runtime graph publisher does not match the pending desktop promotion')
    }
    // Why: a renderer may publish after a failed promotion was restored to
    // headless authority; accepting that late healthy graph is self-healing.
    host.attachWindow(windowId)
  }
  if (host.state.authoritativeWindowId === null) {
    host.state.authoritativeWindowId = windowId
  }
  if (windowId !== host.state.authoritativeWindowId) {
    throw new Error('Runtime graph publisher does not match the authoritative window')
  }
  const rendererGeneration =
    windowId === HEADLESS_RUNTIME_WINDOW_ID
      ? null
      : 'rendererGeneration' in graph && typeof graph.rendererGeneration === 'string'
        ? graph.rendererGeneration
        : undefined
  if (
    typeof rendererGeneration === 'string' &&
    rendererGeneration === host.state.rendererGeneration &&
    host.state.graphStatus !== 'ready'
  ) {
    throw new Error('Runtime graph publisher belongs to a superseded renderer generation')
  }
  if (windowId === HEADLESS_RUNTIME_WINDOW_ID) {
    host.state.headlessGraphFallbackAvailable = true
    host.state.rendererGeneration = null
  }

  return rendererGeneration
}
