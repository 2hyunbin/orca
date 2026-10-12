// Stack-internal bridge (PR 6a until 6g; never reaches main alone). Until 6g, old writers (the
// window's session saves, pty:spawn bindings, headless tab edits, Store-internal catalog writers)
// still write the Store directly. When a host partition the holder holds was last written by
// someone else, it is reloaded into the holder through the Loader, so the holder's next save does
// not erase that write. Start attempts, last outcomes and exit facts are kept by leaf id, and so is
// the tab of a live client-hosted browser page, which the runtime added and the window never saves.
// Runs on each Store write notice and before each holder read. Deleted in 6g with the last external
// writer.

import type { ExecutionHostId } from '../../shared/execution-host'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import type {
  LayoutBrowserTab,
  WorkspaceLayout,
  WorkspaceLayoutModel
} from '../../shared/workspace-layout/workspace-layout-model'
import type { PublishedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-published'
import type { RuntimeBrowserClientPage } from './runtime-browser-page-registry'
import type { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'
import type { HolderStore } from './runtime-workspace-layout-writer'
import type { RuntimeStore } from './runtime-store-contract'
import { spilledTerminalTabsFor } from './runtime-spilled-terminal-tabs'

type ClientPage = Pick<RuntimeBrowserClientPage, 'browserPageId' | 'workspaceId'>

export function reloadHolderOnExternalWrites(
  holder: RuntimeWorkspaceLayouts,
  store: HolderStore & Pick<RuntimeStore, 'onWorkspaceSessionWritten'>,
  liveClientPages: () => readonly ClientPage[] = () => []
): void {
  const reloadIfWrittenElsewhere = (hostId: ExecutionHostId): void => {
    const session = store.getWorkspaceSession(hostId)
    if (holder.isSaving() || session === holder.savedSession(hostId)) {
      return
    }
    const { changes: _changes, ...loaded } = loadWorkspaceLayout(
      hostId,
      session,
      nameBasedLoadContext(),
      spilledTerminalTabsFor(store, hostId, holder.isKnownLocalWorkspace)
    )
    keepUnsavedEditorViews(holder, loaded.layout)
    for (const page of liveClientPages()) {
      if (holder.hostIdOf(page.workspaceId) === hostId) {
        keepClientBrowserTab(holder.published(page.workspaceId), loaded.layout, page)
      }
    }
    holder.replacePartition(hostId, session, loaded)
  }
  holder.setExternalWriteCheck(reloadIfWrittenElsewhere)
  store.onWorkspaceSessionWritten?.(() => {
    for (const hostId of store.getWorkspaceSessionHostIds()) {
      // A partition the holder has not read yet loads on first use.
      if (holder.loadedHostIds().includes(hostId)) {
        reloadIfWrittenElsewhere(hostId)
      } else {
        holder.model(hostId)
      }
    }
  })
}

/** Editor tab views are not saved, so a reload keeps each view whose tab it still holds. */
function keepUnsavedEditorViews(
  holder: Pick<RuntimeWorkspaceLayouts, 'published'>,
  layout: WorkspaceLayoutModel
): void {
  for (const [key, workspace] of Object.entries(layout.workspaces)) {
    const tabIds = new Set(workspace.tabs.map((tab) => tab.id))
    const kept = Object.entries(holder.published(key)?.editorViews ?? {}).filter(([tabId]) =>
      tabIds.has(tabId)
    )
    if (kept.length > 0) {
      // The loaded layout is a fresh copy, so this touches no stored data.
      workspace.editorViews = Object.fromEntries(kept)
    }
  }
}

/** A live client page's held tab survives a save that omits it, in its group at its old place. */
function keepClientBrowserTab(
  published: PublishedWorkspaceLayout | undefined,
  layout: WorkspaceLayoutModel,
  page: ClientPage
): void {
  const record = published?.browserTabs.find((entry) => entry.pageIds?.includes(page.browserPageId))
  const tab = published?.tabs.find(
    (entry) => entry.kind === 'browser' && entry.entityId === record?.id
  )
  const loaded = layout.workspaces[page.workspaceId]
  if (
    !published ||
    !record ||
    !tab ||
    loaded?.tabs.some((entry) => entry.id === tab.id) ||
    loaded?.browserTabs?.some((entry) => entry.pageIds?.includes(page.browserPageId))
  ) {
    return
  }
  const workspace: WorkspaceLayout = loaded ?? {
    worktreeId: published.worktreeId,
    tabs: [],
    groups: []
  }
  const oldGroup = published.groups.find((group) => group.tabIds.includes(tab.id))
  const group = workspace.groups.find((entry) => entry.id === oldGroup?.id) ?? workspace.groups[0]
  const index = oldGroup?.tabIds.indexOf(tab.id) ?? 0
  const browserTab: LayoutBrowserTab = {
    id: record.id,
    sessionProfileId: record.sessionProfileId ?? null,
    pageIds: record.pageIds ?? [page.browserPageId],
    createdAt: tab.createdAt
  }
  // The loaded layout is a fresh copy, so this touches no stored data.
  layout.workspaces[page.workspaceId] = {
    ...workspace,
    tabs: [
      ...workspace.tabs,
      {
        id: tab.id,
        kind: 'browser',
        entityId: record.id,
        createdAt: tab.createdAt,
        customTitle: tab.customTitle,
        color: tab.color,
        ...(tab.isPinned ? { isPinned: true } : {})
      }
    ],
    groups: group
      ? workspace.groups.map((entry) =>
          entry === group
            ? { ...entry, tabOrder: entry.tabOrder.toSpliced(index, 0, tab.id) }
            : entry
        )
      : [{ id: oldGroup?.id ?? tab.id, tabOrder: [tab.id] }],
    browserTabs: [...(workspace.browserTabs ?? []), browserTab]
  }
}
