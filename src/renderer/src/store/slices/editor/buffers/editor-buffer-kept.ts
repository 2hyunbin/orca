import type { EditorBufferRecord } from './editor-buffer-record'

/**
 * A dirty record whose last view closed without a prompt (a removal with no dialog). It owns its
 * model, never autosaves (no writer view), and a view reopening its identity joins it.
 */
export type EditorBufferKept = {
  record: EditorBufferRecord
  draft: string | undefined
  /** The views that closed; their model stays alive while the record is kept. */
  viewIds: readonly string[]
}

export type EditorBufferKeptRecords = Record<string, EditorBufferKept>

/** Closing views whose dirty records outlive them, with the drafts they held before closing. */
export type EditorBufferKeepRequest = {
  viewIds: ReadonlySet<string>
  drafts: Readonly<Record<string, string>>
}

// Why module state: purges close tabs inside a store updater, which can't write the store again;
// the record middleware runs in that same write and takes the requests.
let keepRequests = new Set<string>()

/** Asks the record middleware to keep these views' dirty records when the current write closes them. */
export function requestKeepEditorBuffers(viewIds: Iterable<string>): void {
  for (const viewId of viewIds) {
    keepRequests.add(viewId)
  }
}

export function takeEditorBufferKeepRequests(): ReadonlySet<string> {
  const taken = keepRequests
  keepRequests = new Set()
  return taken
}

/** Whether `viewId` closed into a kept record, so its model must stay alive. */
export function isKeptEditorBufferView(kept: EditorBufferKeptRecords, viewId: string): boolean {
  return Object.values(kept).some((entry) => entry.viewIds.includes(viewId))
}
