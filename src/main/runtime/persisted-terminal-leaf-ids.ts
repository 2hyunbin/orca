import { isTerminalLeafId } from '../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'

/** Every pane id a saved layout names: its tree, its focused pane and its bindings. */
export function collectPersistedTerminalLeafIds(
  layout: TerminalLayoutSnapshot | undefined
): string[] {
  if (!layout) {
    return []
  }
  const leafIds = new Set<string>()
  const visit = (node: TerminalLayoutSnapshot['root']): void => {
    if (!node) {
      return
    }
    if (node.type === 'leaf') {
      if (isTerminalLeafId(node.leafId)) {
        leafIds.add(node.leafId)
      }
      return
    }
    visit(node.first)
    visit(node.second)
  }
  visit(layout.root)
  if (layout.activeLeafId && isTerminalLeafId(layout.activeLeafId)) {
    leafIds.add(layout.activeLeafId)
  }
  for (const leafId of Object.keys(layout.ptyIdsByLeafId ?? {})) {
    if (isTerminalLeafId(leafId)) {
      leafIds.add(leafId)
    }
  }
  return [...leafIds]
}
