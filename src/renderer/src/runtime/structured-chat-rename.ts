import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import type { Tab } from '../../../shared/tab-types'
import { normalizeAgentSessionConversationName } from '../../../shared/agent-session-conversation-name'
import { callRuntimeRpc } from './runtime-rpc-client'
import { supportsStructuredAgentSessionRename } from './structured-agent-session-client'
import { structuredAgentSessionTargetForTab } from './structured-agent-session-owner'

type RenameResult = { name: string | null; applied: boolean }

/**
 * Names a chat on the host that owns it: the one name Session History, tabs, sidebars and phones
 * read, so it outlives the tab. A host too old to store it keeps the name on this window's tab, as
 * before names were saved there.
 */
export async function renameStructuredChatTab(
  get: () => AppState,
  tab: Tab,
  title: string | null,
  opts: { recordInteraction?: boolean } | undefined,
  keepOnTab: () => void
): Promise<void> {
  const target = structuredAgentSessionTargetForTab(get(), tab)
  if (!target || !(await supportsStructuredAgentSessionRename(target))) {
    keepOnTab()
    return
  }
  const name = normalizeAgentSessionConversationName(title)
  if (name === null) {
    // Clearing would leave the chat with no name for good: naming runs once, on the first message.
    toast.error(translate('components.tab.bar.chatRename.empty', "A chat name can't be empty"))
    return
  }
  if (opts?.recordInteraction !== false) {
    get().recordFeatureInteraction?.('terminal-tabs')
  }
  try {
    await callRuntimeRpc<RenameResult>(target, 'agentSession.rename', {
      sessionId: tab.entityId,
      name
    })
  } catch (error) {
    console.warn('[structured-chat-rename] rename failed', error)
    toast.error(translate('components.tab.bar.chatRename.failed', "Couldn't rename this chat"))
    return
  }
  dropLegacyAlias(get, tab.id, tab.customLabel ?? null)
}

/**
 * Uploads a tab rename this window saved before names lived on the host. The host takes it only
 * while the chat still has Orca's own name, so a later rename from any window wins; either way the
 * host's name is the chat's name from then on and the tab stops carrying its own.
 */
export async function uploadLegacyStructuredChatRename(
  get: () => AppState,
  tab: Tab,
  alias: string
): Promise<boolean> {
  const target = structuredAgentSessionTargetForTab(get(), tab)
  if (!target || !(await supportsStructuredAgentSessionRename(target))) {
    return false
  }
  try {
    await callRuntimeRpc<RenameResult>(target, 'agentSession.rename', {
      sessionId: tab.entityId,
      name: alias,
      legacyAlias: true
    })
  } catch (error) {
    console.warn('[structured-chat-rename] legacy rename upload failed', error)
    return false
  }
  dropLegacyAlias(get, tab.id, alias)
  return true
}

/** Clears the tab's own name only if it is still the one the host just answered for. */
function dropLegacyAlias(get: () => AppState, tabId: string, alias: string | null): void {
  if (alias === null) {
    return
  }
  const current = Object.values(get().unifiedTabsByWorktree)
    .flat()
    .find((entry) => entry.id === tabId)
  if (current?.customLabel === alias) {
    get().setTabCustomLabel(tabId, null, { recordInteraction: false })
  }
}
