import { isDeepStrictEqual } from 'node:util'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import { workspaceViewUiValues } from '../../shared/workspace-view/workspace-view-ui-fields'
import type { RuntimeStore } from './runtime-store-contract'

/**
 * Tells subscribed clients when the Workspace options change, so a phone re-reads the value it
 * shares with this host instead of waiting for its next focus. Other UI edits (a sidebar drag)
 * would otherwise trigger a re-read on every frame.
 */
export function publishWorkspaceViewChanges(
  store: Pick<RuntimeStore, 'getUI' | 'onUIChanged'> | null,
  emit: (event: RuntimeClientEvent) => void
): void {
  if (!store?.getUI || !store.onUIChanged) {
    return
  }
  let previous = workspaceViewUiValues(store.getUI())
  store.onUIChanged((ui) => {
    const next = workspaceViewUiValues(ui)
    if (!isDeepStrictEqual(previous, next)) {
      previous = next
      emit({ type: 'workspaceViewChanged' })
    }
  })
}
