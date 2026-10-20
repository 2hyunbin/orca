// Making preview tabs permanent in a layout-owner build: main promotes each tab and its frame
// clears the flag; the window changes no tab itself. A tab main is not asked about (a paired
// server owns its workspace, or main routes a twin's there) is promoted here, as today.

import type { Tab } from '../../../../../shared/tab-types'
import { sendLayoutApply } from '@/runtime/layout-apply-send'
import type { AppState } from '../../types'
import { withPreviewEnded } from './tab-preview-flag'

type TabsState = Pick<AppState, 'unifiedTabsByWorktree'>
type SetTabs = (update: (state: TabsState) => TabsState) => void

/** Ends these tabs' previews in the window's own copy. */
export function endPreviewTabsHere(set: SetTabs, tabIds: ReadonlySet<string>): void {
  if (tabIds.size === 0) {
    return
  }
  set((state) => ({
    unifiedTabsByWorktree: Object.fromEntries(
      Object.entries(state.unifiedTabsByWorktree).map(([worktreeId, tabs]) => [
        worktreeId,
        tabs.map((tab) => (tabIds.has(tab.id) && tab.isPreview ? withPreviewEnded(tab) : tab))
      ])
    )
  }))
}

/** Tabs whose promotion main has yet to answer: a second ask (a pin after its keep) is dropped. */
const promoting = new Set<string>()

export function promotePreviewTabsThroughLayoutOwner(
  state: Parameters<typeof sendLayoutApply>[0],
  set: SetTabs,
  tabs: readonly Pick<Tab, 'id' | 'worktreeId'>[]
): void {
  const here: string[] = []
  for (const tab of tabs) {
    const key = `${tab.worktreeId}\0${tab.id}`
    if (promoting.has(key)) {
      continue
    }
    promoting.add(key)
    const done = (): void => {
      promoting.delete(key)
    }
    const sent = sendLayoutApply(
      state,
      tab.worktreeId,
      { type: 'promotePreviewTab', tabId: tab.id },
      {
        apply: done,
        asToday: () => {
          done()
          endPreviewTabsHere(set, new Set([tab.id]))
        },
        refused: done
      }
    )
    if (!sent) {
      done()
      here.push(tab.id)
    }
  }
  endPreviewTabsHere(set, new Set(here))
}
