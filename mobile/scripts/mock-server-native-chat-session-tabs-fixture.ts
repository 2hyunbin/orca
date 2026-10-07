import { randomUUID } from 'node:crypto'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import {
  getRenderScrollChats,
  renderScrollPreview
} from './mock-server-native-chat-render-scroll-fixture'

const PUBLICATION_EPOCH = `mock-native-chat:${randomUUID()}`
const activeTabs = new Map<string, string>()

export function activateRenderScrollTab(worktree: string, selector: unknown): void {
  const chat = getRenderScrollChats().find(
    (entry) => selector === entry.tabId || selector === `${entry.tabId}::${entry.leafId}`
  )
  if (chat) {
    activeTabs.set(worktree, chat.tabId)
  }
}

export function createRenderScrollSessionTabs(worktree: string): RuntimeMobileSessionTabsResult {
  const renderScrollChats = getRenderScrollChats()
  const active = activeTabs.get(worktree) ?? renderScrollChats[0]!.tabId
  const tabs = renderScrollChats.map((chat) => {
    const preview = renderScrollPreview(chat)
    const surfaceId = `${chat.tabId}::${chat.leafId}`
    return {
      type: 'terminal' as const,
      id: surfaceId,
      parentTabId: chat.tabId,
      leafId: chat.leafId,
      title: `Claude iPad ${chat.label}`,
      terminal: chat.terminal,
      status: 'ready' as const,
      launchAgent: 'claude' as const,
      viewMode: 'chat' as const,
      isActive: chat.tabId === active,
      agentStatus: {
        state: preview === undefined ? ('done' as const) : ('working' as const),
        prompt: '',
        updatedAt: chat.updatedAt,
        stateStartedAt: chat.replyStartedAt ?? chat.updatedAt,
        agentType: 'claude',
        paneKey: `${chat.tabId}:${chat.leafId}`,
        terminalHandle: chat.terminal,
        stateHistory: [],
        ...(preview === undefined ? {} : { lastAssistantMessage: preview }),
        providerSession: {
          key: 'session_id' as const,
          id: chat.sessionId,
          transcriptPath: chat.transcriptPath
        }
      }
    }
  })
  return {
    worktree,
    publicationEpoch: PUBLICATION_EPOCH,
    snapshotVersion: 0,
    activeGroupId: 'group-1',
    activeTabId: tabs.find((tab) => tab.isActive)!.id,
    activeTabType: 'terminal',
    tabGroups: [
      { id: 'group-1', activeTabId: active, tabOrder: renderScrollChats.map((chat) => chat.tabId) }
    ],
    tabs
  }
}
