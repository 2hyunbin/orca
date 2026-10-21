// Editor tabs this desktop opened in a paired server's workspace while it mirrored it (the 3a list)
// go to that server's main before its frames draw the workspace (H5d): frames list only the
// server's tabs, so gating first would drop these with their open files and drafts.

import type { AppState } from '@/store/types'
import { editorTabContent } from '@/store/slices/editor/tabs/editor-tab-open-through-layout-owner'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { sendToServerMain, type WindowLayoutCommand } from './layout-apply-send'
import { serverEditorOpen } from './server-layout-apply'

type EditorOpen = Extract<WindowLayoutCommand, { type: 'openEditorTab' }>

/** One server stream's hand-overs; a new stream starts with none. */
export type ServerEditorHandover = {
  /** Whether a workspace not yet gated may gate now; if not, hands its desktop-only tabs over. */
  admits: (key: string) => boolean
  /** The stream is gone: answers still to come change nothing. */
  close: () => void
}

/**
 * The editor tabs the window shows in a workspace that the server's layout does not list, as
 * opens under their own ids, in tab order. A file the mirror drew from the server is the server's.
 */
function desktopOnlyEditorOpens(
  state: AppState,
  key: string,
  layout: PublishedWorkspaceLayout | undefined
): EditorOpen[] {
  const listed = new Set(layout?.tabs.map((tab) => tab.id))
  const tabs = new Map((state.unifiedTabsByWorktree[key] ?? []).map((tab) => [tab.id, tab]))
  const order = new Set((state.groupsByWorktree[key] ?? []).flatMap((group) => group.tabOrder))
  return [...order].flatMap((tabId) => {
    const tab = tabs.get(tabId)
    if (!tab || listed.has(tab.id) || !isEditorTabContentType(tab.contentType)) {
      return []
    }
    const file = state.openFiles.find((open) => open.id === tab.entityId && open.worktreeId === key)
    if (!file || file.mirroredFromRuntimeSession === true) {
      return []
    }
    return [
      {
        type: 'openEditorTab',
        tabId: tab.id,
        fileId: tab.entityId,
        contentType: tab.contentType,
        ...editorTabContent(file),
        // A group only this desktop drew is not the server's: its main then places the tab itself.
        ...(layout?.groups.some((group) => group.id === tab.groupId)
          ? { groupId: tab.groupId }
          : {}),
        ...(tab.isPreview ? { preview: true } : {}),
        createdAt: tab.createdAt
      }
    ]
  })
}

/**
 * Hands a workspace's desktop-only editor tabs to the server's main, then reports when all have
 * answered. An open answered `tab_exists` is the server's already (a retry after a reconnect); any
 * other refusal, or a failed call, keeps the workspace mirror-drawn for the rest of this stream.
 */
export function createServerEditorHandover(options: {
  environmentId: string
  getState: () => AppState
  serverLayout: (key: string) => PublishedWorkspaceLayout | undefined
  /** A workspace's hand-overs all answered: it may gate now. */
  onAnswered: () => void
}): ServerEditorHandover {
  const handedOver = new Map<string, Set<string>>()
  const waiting = new Map<string, number>()
  const notGateable = new Set<string>()
  let closed = false

  const answer =
    (key: string, tabId: string) =>
    (reply: LayoutApplyReply | null): void => {
      if (closed) {
        return
      }
      if (reply?.ok || reply?.code === 'tab_exists') {
        const tabs = handedOver.get(key) ?? new Set()
        handedOver.set(key, tabs.add(tabId))
      } else {
        console.warn(
          '[layout-owner] an editor tab stays on this desktop:',
          reply?.code ?? 'call_failed'
        )
        notGateable.add(key)
      }
      const left = (waiting.get(key) ?? 1) - 1
      if (left > 0) {
        waiting.set(key, left)
        return
      }
      waiting.delete(key)
      options.onAnswered()
    }

  return {
    admits: (key) => {
      if (closed || notGateable.has(key) || waiting.has(key)) {
        return false
      }
      // Recomputed on each ask: a tab opened meanwhile goes too, and a tab closed meanwhile does not.
      const opens = desktopOnlyEditorOpens(
        options.getState(),
        key,
        options.serverLayout(key)
      ).filter((open) => !handedOver.get(key)?.has(open.tabId))
      if (opens.length === 0) {
        return true
      }
      waiting.set(key, opens.length)
      for (const open of opens) {
        sendToServerMain(
          options.environmentId,
          key,
          serverEditorOpen(key, open),
          answer(key, open.tabId)
        )
      }
      return false
    },
    close: () => {
      closed = true
    }
  }
}
