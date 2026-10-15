// A session saved before the tab bar existed has terminal rows and open files but no tab-bar
// entries or groups. The window and the Loader rebuild each workspace's one group the same way.

import type { Tab, TabGroup } from '../tab-types'
import { isValidTerminalTabId } from '../terminal-tab-id'
import type { WorkspaceSessionState } from '../workspace-session-state-types'

/** The window's gate, on its merged session; the Loader's per-host gate is stricter. */
export function isSessionWithoutTabBar(session: WorkspaceSessionState): boolean {
  return !(session.unifiedTabs && session.tabGroups)
}

/**
 * One workspace's group: its terminal rows then its open files in stored order, with the tab it
 * last showed active. `now` stamps the editor tabs, which stored no creation time.
 */
export function buildLegacyWorkspaceTabBar(
  session: WorkspaceSessionState,
  worktreeId: string,
  { mintGroupId, now }: { mintGroupId: () => string; now: number }
): { tabs: Tab[]; group: TabGroup } | undefined {
  const terminalTabs = (session.tabsByWorktree[worktreeId] ?? []).filter((tab) =>
    isValidTerminalTabId(tab.id)
  )
  const editorFiles = session.openFilesByWorktree?.[worktreeId] ?? []

  if (terminalTabs.length === 0 && editorFiles.length === 0) {
    return undefined
  }

  const groupId = mintGroupId()
  const tabs: Tab[] = []
  const tabOrder: string[] = []

  for (const tt of terminalTabs) {
    tabs.push({
      id: tt.id,
      entityId: tt.id,
      groupId,
      worktreeId,
      contentType: 'terminal',
      label: tt.title,
      ...(tt.quickCommandLabel?.trim() ? { quickCommandLabel: tt.quickCommandLabel.trim() } : {}),
      ...(tt.generatedTitle?.trim() ? { generatedLabel: tt.generatedTitle.trim() } : {}),
      customLabel: tt.customTitle,
      color: tt.color,
      sortOrder: tt.sortOrder,
      createdAt: tt.createdAt,
      isPreview: false,
      isPinned: false
    })
    tabOrder.push(tt.id)
  }

  for (const ef of editorFiles) {
    tabs.push({
      id: ef.filePath,
      entityId: ef.filePath,
      groupId,
      worktreeId,
      contentType: 'editor',
      label: ef.relativePath,
      customLabel: null,
      color: null,
      sortOrder: tabs.length,
      createdAt: now,
      isPreview: ef.isPreview,
      isPinned: false
    })
    tabOrder.push(ef.filePath)
  }

  const activeTabType = session.activeTabTypeByWorktree?.[worktreeId] ?? 'terminal'
  let activeTabId: string | null = null
  if (activeTabType === 'editor') {
    activeTabId = session.activeFileIdByWorktree?.[worktreeId] ?? null
  } else {
    // Why: honor this worktree's own remembered terminal before the global
    // active tab. The global session.activeTabId only names the last-focused
    // worktree's tab, so using it here reset every other worktree to its
    // first terminal on restart.
    const rememberedTabId = session.activeTabIdByWorktree?.[worktreeId]
    if (rememberedTabId && terminalTabs.some((t) => t.id === rememberedTabId)) {
      activeTabId = rememberedTabId
    } else if (session.activeTabId && terminalTabs.some((t) => t.id === session.activeTabId)) {
      activeTabId = session.activeTabId
    }
  }
  if (activeTabId && !tabs.some((t) => t.id === activeTabId)) {
    activeTabId = tabs[0]?.id ?? null
  }

  return {
    tabs,
    group: {
      id: groupId,
      worktreeId,
      activeTabId,
      tabOrder,
      // Why: legacy sessions don't persist MRU; seed with the active tab so
      // the first close after a legacy restore still behaves MRU-ish (falls
      // back to neighbor selection if only one tab is in the stack).
      recentTabIds: activeTabId ? [activeTabId] : []
    }
  }
}
