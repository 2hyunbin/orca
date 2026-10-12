// The frames `layout.subscribe` sends (design 2.4), shared by the runtime that emits them and the
// one client that reads them.

import type { PublishedWorkspaceLayout } from './workspace-layout-published'
import { isLayoutViewRecord, type LayoutViewRecord } from './workspace-layout-views'

export type WorkspaceLayoutEvent =
  | { type: 'workspace'; key: string; layout: PublishedWorkspaceLayout }
  | { type: 'removed'; key: string }

export type WorkspaceLayoutSnapshotEntry = { key: string; layout: PublishedWorkspaceLayout }

/** Asks one view to change its own selection (design 2.4.1); the view may ignore it. */
export type LayoutNavigateRequest =
  | { kind: 'focusTab'; workspace: string; tabId: string }
  | { kind: 'focusPane'; workspace: string; paneKey: string }
  | { kind: 'revealWorkspace'; workspace: string }

export type WorkspaceLayoutStreamFrame =
  | {
      type: 'snapshot'
      // subscriptionId names the stream for `layout.unsubscribe`; a reader does not need it.
      subscriptionId?: string
      workspaces: WorkspaceLayoutSnapshotEntry[]
      /** The subscribing view's own record, so its selection never lags the layout. */
      view?: LayoutViewRecord
    }
  | WorkspaceLayoutEvent
  // Sent only on the addressed view's subscriptions.
  | { type: 'navigate'; request: LayoutNavigateRequest }
  | { type: 'end' }

/** What a reader's cache takes from the stream. */
export type WorkspaceLayoutChangeFrame = Exclude<
  WorkspaceLayoutStreamFrame,
  { type: 'end' } | { type: 'navigate' }
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

// Checks the top-level shape only; the fields inside are the host's published contract.
function isPublishedWorkspaceLayout(value: unknown): value is PublishedWorkspaceLayout {
  return (
    isRecord(value) &&
    typeof value.worktreeId === 'string' &&
    Array.isArray(value.groups) &&
    Array.isArray(value.tabs) &&
    Array.isArray(value.editorFiles) &&
    Array.isArray(value.browserTabs)
  )
}

export function readLayoutNavigateRequest(value: unknown): LayoutNavigateRequest | null {
  if (!isRecord(value) || !isKey(value.workspace)) {
    return null
  }
  const { workspace } = value
  switch (value.kind) {
    case 'focusTab':
      return isKey(value.tabId) ? { kind: 'focusTab', workspace, tabId: value.tabId } : null
    case 'focusPane':
      return isKey(value.paneKey) ? { kind: 'focusPane', workspace, paneKey: value.paneKey } : null
    case 'revealWorkspace':
      return { kind: 'revealWorkspace', workspace }
    default:
      return null
  }
}

function isSnapshotEntry(value: unknown): value is WorkspaceLayoutSnapshotEntry {
  return isRecord(value) && isKey(value.key) && isPublishedWorkspaceLayout(value.layout)
}

/** Null for a malformed frame or a frame type this build does not know (a newer host's). */
export function readWorkspaceLayoutStreamFrame(value: unknown): WorkspaceLayoutStreamFrame | null {
  if (!isRecord(value)) {
    return null
  }
  switch (value.type) {
    case 'snapshot':
      if (!Array.isArray(value.workspaces) || !value.workspaces.every(isSnapshotEntry)) {
        return null
      }
      return isLayoutViewRecord(value.view)
        ? { type: 'snapshot', workspaces: value.workspaces, view: value.view }
        : { type: 'snapshot', workspaces: value.workspaces }
    case 'workspace':
      return isKey(value.key) && isPublishedWorkspaceLayout(value.layout)
        ? { type: 'workspace', key: value.key, layout: value.layout }
        : null
    case 'removed':
      return isKey(value.key) ? { type: 'removed', key: value.key } : null
    case 'navigate': {
      const request = readLayoutNavigateRequest(value.request)
      return request ? { type: 'navigate', request } : null
    }
    case 'end':
      return { type: 'end' }
    default:
      return null
  }
}
