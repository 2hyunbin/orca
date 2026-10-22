import type { AppState } from '@/store/types'
import type { Tab } from '../../../shared/tab-types'
import {
  legacyStructuredChatRenameOwner,
  structuredAgentSessionTargetForTab
} from './structured-agent-session-owner'

const intents = new WeakMap<Tab, object>()

/** Capture the submitted occurrence and address before the rename module loads or navigation moves. */
export function captureStructuredChatRename(get: () => AppState, tab: Tab) {
  const state = get()
  const target = structuredAgentSessionTargetForTab(state, tab)
  const retainAlias = legacyStructuredChatRenameOwner(state, tab) === null
  const intent = {}
  intents.set(tab, intent)
  return {
    target,
    retainAlias,
    current: () =>
      intents.get(tab) === intent &&
      get().unifiedTabsByWorktree[tab.worktreeId]?.find((entry) => entry.id === tab.id) === tab,
    finish: () => {
      if (intents.get(tab) === intent) {
        intents.delete(tab)
      }
    }
  }
}
