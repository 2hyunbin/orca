// Making preview tabs permanent in a layout-owner build: main promotes each tab and its frame
// clears the flag; the window changes no tab itself. A workspace whose layout a paired server
// owns is not main's to change, so the window ends its tabs' previews there, as today.

import type { Tab } from '../../../../../shared/tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { sendLayoutApply } from '@/runtime/layout-apply-send'

type OwnerState = Parameters<typeof sendLayoutApply>[0]

/** Whether the window ends a preview in its own copy: always with the switch off. */
export function endsPreviewHere(state: OwnerState, worktreeId: string): boolean {
  return !ORCA_LAYOUT_OWNER_IS_MAIN || runtimeEnvironmentIdUnlessTwin(state, worktreeId) !== null
}

/** Tabs whose promotion main has yet to answer: a second ask (a pin after its keep) is dropped. */
const promoting = new Set<string>()

/** Asks main to promote the tabs it owns; the frame that answers clears their flag. */
export function promotePreviewTabsThroughLayoutOwner(
  state: OwnerState,
  tabs: readonly Pick<Tab, 'id' | 'worktreeId'>[]
): void {
  for (const tab of tabs) {
    const key = `${tab.worktreeId}\0${tab.id}`
    if (endsPreviewHere(state, tab.worktreeId) || promoting.has(key)) {
      continue
    }
    promoting.add(key)
    const done = (): void => {
      promoting.delete(key)
    }
    // asToday: main routed a twin's tab to a paired server, whose mirror shows its flag.
    sendLayoutApply(
      state,
      tab.worktreeId,
      { type: 'promotePreviewTab', tabId: tab.id },
      { apply: done, asToday: done, refused: done }
    )
  }
}
