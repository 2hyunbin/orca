// A paired server's layout frames under the ids this desktop already gives that server's tabs (the
// session.tabs mirror's), so a workspace moves between the two sources without a remount. The one
// place server ids become desktop ids; layout.apply maps back through the same rules.

import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import type { TabContentType } from '../../../shared/tab-types'
import {
  isWebTerminalSurfaceTabId,
  toHostSessionTabId,
  toWebTerminalSurfaceTabId
} from '../../../shared/terminal-surface-id'
import { ownedEditorFileId } from '../../../shared/workspace-session-pane-ownership'
import type {
  PublishedEditorFile,
  PublishedPane,
  PublishedTab,
  PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import {
  applyWorkspaceLayoutRecordChange,
  diffPublishedLayouts,
  indexPublishedLayout,
  type IndexedLayoutRecords,
  type WorkspaceLayoutRecordChange
} from '../../../shared/workspace-layout/workspace-layout-records'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'

/** Which tab ids a kind changes: a terminal's take the mirror's surface prefix, others keep theirs. */
const TAB_ID_RULES: Record<TabContentType, 'terminal' | 'kept'> = {
  terminal: 'terminal',
  editor: 'kept',
  diff: 'kept',
  'conflict-review': 'kept',
  'check-details': 'kept',
  'agent-session': 'kept',
  browser: 'kept',
  simulator: 'kept'
}

function tabIdRule(kind: string): 'terminal' | 'kept' {
  const rule = (TAB_ID_RULES as Record<string, 'terminal' | 'kept' | undefined>)[kind]
  if (!rule) {
    // A newer server's tab kind: drawing it under raw ids would mix two id spaces.
    throw new Error(`server layout: unknown tab kind ${kind}`)
  }
  return rule
}

/** An editor tab names its file by path, or by the owned id of the server's own (local) file. */
function desktopEditorEntityId(
  entityId: string,
  layout: PublishedWorkspaceLayout,
  environmentId: string
): string {
  const file = layout.editorFiles.find(
    (candidate) =>
      ownedEditorFileId(candidate.filePath, layout.worktreeId, candidate.runtimeEnvironmentId) ===
      entityId
  )
  return file ? ownedEditorFileId(file.filePath, layout.worktreeId, environmentId) : entityId
}

function desktopPane(pane: PublishedPane, environmentId: string): PublishedPane {
  const { ptyId, handle, ptyGeneration, ...rest } = pane
  // The desktop attaches by the server's handle, as the mirror does; a pane without one waits.
  return handle
    ? {
        ...rest,
        ptyId: toRemoteRuntimePtyId(handle, environmentId),
        ...(ptyGeneration !== undefined ? { ptyGeneration } : {})
      }
    : rest
}

function desktopTab(
  tab: PublishedTab,
  layout: PublishedWorkspaceLayout,
  host: ExecutionHostId,
  environmentId: string
): PublishedTab {
  const terminal = tabIdRule(tab.kind) === 'terminal'
  return {
    ...tab,
    id: terminal ? toWebTerminalSurfaceTabId(tab.id) : tab.id,
    entityId: terminal
      ? toWebTerminalSurfaceTabId(tab.entityId)
      : tab.kind === 'editor'
        ? desktopEditorEntityId(tab.entityId, layout, environmentId)
        : tab.entityId,
    executionHostId: host,
    ...(tab.terminal
      ? {
          terminal: {
            ...tab.terminal,
            panes: tab.terminal.panes.map((pane) => desktopPane(pane, environmentId))
          }
        }
      : {})
  }
}

function desktopEditorFile(file: PublishedEditorFile, environmentId: string): PublishedEditorFile {
  // The server's SSH target names a host of the server's, never one of this desktop's.
  const { externalSshTargetId: _serverTarget, ...rest } = file
  return { ...rest, runtimeEnvironmentId: environmentId }
}

/** One workspace of a server's frames under this desktop's ids. */
export function serverLayoutForDesktop(
  layout: PublishedWorkspaceLayout,
  environmentId: string
): PublishedWorkspaceLayout {
  const host = toRuntimeExecutionHostId(environmentId)
  const terminalTabIds = new Set(
    layout.tabs.filter((tab) => tabIdRule(tab.kind) === 'terminal').map((tab) => tab.id)
  )
  const tabId = (id: string) => (terminalTabIds.has(id) ? toWebTerminalSurfaceTabId(id) : id)
  return {
    ...layout,
    groups: layout.groups.map((group) => ({ ...group, tabIds: group.tabIds.map(tabId) })),
    tabs: layout.tabs.map((tab) => desktopTab(tab, layout, host, environmentId)),
    editorFiles: layout.editorFiles.map((file) => desktopEditorFile(file, environmentId)),
    browserTabs: layout.browserTabs
  }
}

/** A desktop tab id as the server knows it. */
export function serverTabIdOf(desktopTabId: string): string {
  return isWebTerminalSurfaceTabId(desktopTabId) ? toHostSessionTabId(desktopTabId) : desktopTabId
}

/**
 * Translates one server stream's frames in order. It keeps the server's copy of each workspace, so
 * a records frame is re-diffed under desktop ids: a record's key can depend on another record (a
 * group names terminal tabs by their kind), which one frame alone may not carry.
 */
export function createServerLayoutFrameTranslator(
  environmentId: string
): (frame: WorkspaceLayoutChangeFrame) => WorkspaceLayoutChangeFrame {
  const server = new Map<string, PublishedWorkspaceLayout>()
  const desktop = new Map<string, { layout: PublishedWorkspaceLayout; index: IndexedLayoutRecords | null }>()

  const show = (key: string, layout: PublishedWorkspaceLayout): PublishedWorkspaceLayout => {
    const translated = serverLayoutForDesktop(layout, environmentId)
    server.set(key, layout)
    desktop.set(key, { layout: translated, index: indexPublishedLayout(translated) })
    return translated
  }
  const drop = (key: string): void => {
    server.delete(key)
    desktop.delete(key)
  }

  const recordChange = (change: WorkspaceLayoutRecordChange): WorkspaceLayoutRecordChange[] => {
    if (change.change === 'removed') {
      drop(change.key)
      return [change]
    }
    if (change.change === 'layout') {
      return [{ ...change, layout: show(change.key, change.layout) }]
    }
    const before = desktop.get(change.key)
    // Throws for a change that does not fit: the stream then resubscribes for a snapshot.
    const after = applyWorkspaceLayoutRecordChange(server.get(change.key), change)!
    const translated = show(change.key, after)
    const diff = diffPublishedLayouts(
      change.key,
      before?.index ?? null,
      desktop.get(change.key)!.index,
      translated
    )
    return diff ? [diff] : []
  }

  return (frame) => {
    switch (frame.type) {
      case 'snapshot':
        server.clear()
        desktop.clear()
        return {
          ...frame,
          workspaces: frame.workspaces.map(({ key, layout }) => ({ key, layout: show(key, layout) }))
        }
      case 'workspace':
        return { ...frame, layout: show(frame.key, frame.layout) }
      case 'removed':
        drop(frame.key)
        return frame
      case 'records':
        return { ...frame, workspaces: frame.workspaces.flatMap(recordChange) }
    }
  }
}
