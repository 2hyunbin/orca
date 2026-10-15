import { isDeepStrictEqual } from 'node:util'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import { WORKSPACE_ROW_FILTER_UI_FIELDS } from '../../shared/workspace-view/workspace-row-filters'
import type { RuntimeStore } from './runtime-store-contract'

/** The UI state a phone's Workspace options re-read applies (applyDesktopViewSettings). */
const WORKSPACE_VIEW_UI_FIELDS: readonly (keyof PersistedUIState)[] = [
  ...Object.values(WORKSPACE_ROW_FILTER_UI_FIELDS),
  'groupBy',
  'sortBy',
  'projectOrderBy',
  'worktreeCardProperties',
  'agentActivityDisplayMode',
  'collapsedGroups',
  'workspaceStatuses'
]

/** The settings behind Card layout and which card options show. */
const WORKSPACE_VIEW_SETTINGS: readonly (keyof GlobalSettings)[] = [
  'compactWorktreeCards',
  'experimentalNewWorktreeCardStyle'
]

function workspaceViewUiValues(ui: PersistedUIState): unknown[] {
  return WORKSPACE_VIEW_UI_FIELDS.map((key) => ui[key])
}

/**
 * Tells subscribed clients when the Workspace options change, so a phone re-reads the value it
 * shares with this host instead of waiting for its next focus. Other UI edits (a sidebar drag)
 * would otherwise trigger a re-read on every frame.
 */
export function publishWorkspaceViewChanges(
  store:
    | (Pick<RuntimeStore, 'getUI' | 'onUIChanged'> & {
        onSettingsChanged?: (listener: (updates: Partial<GlobalSettings>) => void) => unknown
      })
    | null,
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
  // Card layout and the card style are settings, not UI state.
  store.onSettingsChanged?.((updates) => {
    if (WORKSPACE_VIEW_SETTINGS.some((key) => key in updates)) {
      emit({ type: 'workspaceViewChanged' })
    }
  })
}
