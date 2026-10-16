// The frames `layout.subscribe` sends (design 2.4), shared by the runtime that emits them and the
// one client that reads them.

import type { PublishedWorkspaceLayout } from './workspace-layout-published'

/** `seq`: the stream's position after this frame, rising by one per change frame for the host's
 *  life. A `layout.apply` reply names the position holding its effect. Absent from older hosts. */
type Sequenced = { seq?: number }

export type WorkspaceLayoutEvent = (
  | { type: 'workspace'; key: string; layout: PublishedWorkspaceLayout }
  | { type: 'removed'; key: string }
) &
  Sequenced

export type WorkspaceLayoutSnapshotEntry = { key: string; layout: PublishedWorkspaceLayout }

export type WorkspaceLayoutStreamFrame =
  // subscriptionId names the stream for `layout.unsubscribe`; a reader does not need it.
  | ({
      type: 'snapshot'
      subscriptionId?: string
      workspaces: WorkspaceLayoutSnapshotEntry[]
    } & Sequenced)
  | WorkspaceLayoutEvent
  | { type: 'end' }

/** What a reader's cache takes from the stream. */
export type WorkspaceLayoutChangeFrame = Exclude<WorkspaceLayoutStreamFrame, { type: 'end' }>

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

/** The frame's position, kept only when it is one: a malformed one must not move a reader's. */
function sequenced({ seq }: Record<string, unknown>): Sequenced {
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? { seq } : {}
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
      return Array.isArray(value.workspaces) && value.workspaces.every(isSnapshotEntry)
        ? { type: 'snapshot', workspaces: value.workspaces, ...sequenced(value) }
        : null
    case 'workspace':
      return isKey(value.key) && isPublishedWorkspaceLayout(value.layout)
        ? { type: 'workspace', key: value.key, layout: value.layout, ...sequenced(value) }
        : null
    case 'removed':
      return isKey(value.key) ? { type: 'removed', key: value.key, ...sequenced(value) } : null
    case 'end':
      return { type: 'end' }
    default:
      return null
  }
}
