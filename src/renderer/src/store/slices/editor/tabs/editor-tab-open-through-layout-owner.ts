// Editor tab opens in a layout-owner build: the window proposes the tab id and sends the open;
// main's frame draws the tab, and only then is it selected. The open file itself is the window's
// and is written at once. A caller acting on the tab waits with `afterPendingTab`.

import type { Tab } from '../../../../../../shared/tab-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { sendLayoutApply, type WindowLayoutCommand } from '@/runtime/layout-apply-send'
import { beginPendingTab } from '@/runtime/layout-owner-pending-tabs'
import { newGroupSplitOf } from '@/runtime/layout-owner-new-group-split'
import type { AppState } from '../../../types'
import type { EditorTabSelection, OpenFile } from '../types/open-file'
import { isEditorTabContentType, type EditorTabContentType } from './editor-tab-content-type'
import { restorableEditorFile } from './editor-tab-layout-owner'
import { layoutEditorViewOfOpenFile } from './open-file-layout-view'

type EditorTabOpen = {
  fileId: string
  worktreeId: string
  contentType: EditorTabContentType
  isPreview: boolean
  /** The group the window resolved; a dead or missing one falls back as today's create does. */
  groupId: string | undefined
  selection: EditorTabSelection
  index?: number
  /** Today's draw, for a twin main may route to a paired server. */
  drawHere: (tabId: string) => Pick<Tab, 'id'> | undefined
}

/** What lets a reload or a second client rebuild the tab: an edit file's record, any view. */
function editorTabContent(
  file: OpenFile
): Pick<Extract<WindowLayoutCommand, { type: 'openEditorTab' }>, 'file' | 'view'> {
  const view = layoutEditorViewOfOpenFile(file)
  return {
    ...(file.mode === 'edit' ? { file: restorableEditorFile(file) } : {}),
    ...(view ? { view } : {})
  }
}

function openFileOf(state: AppState, worktreeId: string, fileId: string): OpenFile | undefined {
  return state.openFiles.find((file) => file.id === fileId && file.worktreeId === worktreeId)
}

/** A live group of the window's, else its active one, else a root group frames then draw. */
function placementGroupId(
  state: AppState,
  worktreeId: string,
  groupId: string | undefined
): string | undefined {
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const live = (id: string | undefined): id is string =>
    id !== undefined && groups.some((group) => group.id === id)
  if (live(groupId)) {
    return groupId
  }
  const active = state.activeGroupIdByWorktree[worktreeId]
  if (live(active)) {
    return active
  }
  return groups[0]?.id ?? state.ensureWorktreeRootGroup?.(worktreeId)
}

/**
 * Sends a new editor tab's open; returns the proposed tab id, or null when main is not asked (a
 * paired server owns the workspace's layout, or the window lacks the open file): the caller
 * draws it as today.
 */
export function openEditorTabThroughLayoutOwner(
  state: AppState,
  open: EditorTabOpen
): string | null {
  const { fileId, worktreeId } = open
  const file = openFileOf(state, worktreeId, fileId)
  // A store without the tab slice draws no tab, as today's optional create does.
  if (!file || !state.createUnifiedTab) {
    return null
  }
  const tabId = createBrowserUuid()
  const groupId = placementGroupId(state, worktreeId, open.groupId)
  const command: WindowLayoutCommand = {
    type: 'openEditorTab',
    tabId,
    fileId,
    contentType: open.contentType,
    ...editorTabContent(file),
    ...(groupId ? { groupId, ...newGroupSplitOf(state, worktreeId, groupId, tabId) } : {}),
    ...(open.index !== undefined ? { index: open.index } : {}),
    ...(open.isPreview ? { preview: true } : {}),
    createdAt: Date.now()
  }
  const settle = beginPendingTab(tabId, worktreeId, fileId)
  const sent = sendLayoutApply(state, worktreeId, command, {
    apply: (result) => {
      const shownId = result.tabId ?? tabId
      selectDrawnEditorTab(state, worktreeId, shownId, open.selection)
      settle(shownId)
    },
    asToday: () => settle(open.drawHere(tabId)?.id ?? null),
    refused: () => settle(null)
  })
  if (!sent) {
    settle(null)
    return null
  }
  return tabId
}

/** Selects the tab main's frame just drew, as today's create selects it; a new preview stays one. */
function selectDrawnEditorTab(
  state: AppState,
  worktreeId: string,
  tabId: string,
  selection: EditorTabSelection
): void {
  if (selection === 'none') {
    return
  }
  state.activateTab?.(tabId, {
    worktreeId,
    preservePreview: true,
    ...(selection === 'background' ? { recordFocus: false } : {})
  })
}

/** An open the window answered with a tab it already shows: main takes its current record and view. */
export function sendReusedEditorTabToLayoutOwner(
  state: AppState,
  tab: Pick<Tab, 'id' | 'entityId' | 'worktreeId' | 'groupId' | 'contentType' | 'createdAt'>
): void {
  const file = openFileOf(state, tab.worktreeId, tab.entityId)
  if (!file || !isEditorTabContentType(tab.contentType)) {
    return
  }
  const content = editorTabContent(file)
  if (!content.file && !content.view) {
    return
  }
  const keep = (): void => {}
  sendLayoutApply(
    state,
    tab.worktreeId,
    {
      type: 'openEditorTab',
      tabId: tab.id,
      fileId: tab.entityId,
      contentType: tab.contentType,
      ...content,
      groupId: tab.groupId,
      createdAt: tab.createdAt
    },
    { apply: keep, asToday: keep }
  )
}
