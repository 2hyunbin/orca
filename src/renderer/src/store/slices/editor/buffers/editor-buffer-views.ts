import type { OpenFile } from '../types/open-file'

/**
 * Which editor tabs (views) show which buffer record. Maintained by the record middleware in the
 * same store update as `openFiles`, so every entry point resolves views through one index.
 */
export type EditorBufferViewIndex = {
  /** View (tab) id → record id. */
  editorBufferIdOf: Record<string, string>
  /** Record id → its view ids, in `openFiles` order. */
  editorBufferViews: Record<string, readonly string[]>
}

/** States built outside the store (tests, projections) may lack the index; lookups then fall back to one record per tab. */
export type EditorBufferViewLookup = Partial<EditorBufferViewIndex>

export const EMPTY_EDITOR_BUFFER_VIEW_INDEX: EditorBufferViewIndex = {
  editorBufferIdOf: {},
  editorBufferViews: {}
}

/** The record a tab belongs to. One record per tab until views of one file share a record. */
export function editorBufferIdForFile(file: OpenFile): string {
  return file.id
}

export function editorBufferIdOfView(state: EditorBufferViewLookup, viewId: string): string {
  return state.editorBufferIdOf?.[viewId] ?? viewId
}

export function editorBufferViewIds(
  state: EditorBufferViewLookup,
  recordId: string
): readonly string[] {
  return state.editorBufferViews?.[recordId] ?? [recordId]
}

/** Every view sharing `viewId`'s record, including `viewId` itself. */
export function editorBufferSiblingViewIds(
  state: EditorBufferViewLookup,
  viewId: string
): readonly string[] {
  return editorBufferViewIds(state, editorBufferIdOfView(state, viewId))
}

export function isLastEditorBufferView(state: EditorBufferViewLookup, viewId: string): boolean {
  return editorBufferSiblingViewIds(state, viewId).every((id) => id === viewId)
}

function sameViewIds(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((id, index) => id === b[index])
}

/** Rebuilds the index from `openFiles`; returns `previous` itself when nothing moved. */
export function reconcileEditorBufferViewIndex(
  previous: EditorBufferViewIndex,
  openFiles: readonly OpenFile[]
): EditorBufferViewIndex {
  const idOf: Record<string, string> = {}
  const views: Record<string, string[]> = {}
  for (const file of openFiles) {
    const recordId = editorBufferIdForFile(file)
    idOf[file.id] = recordId
    ;(views[recordId] ??= []).push(file.id)
  }
  const idOfKeys = Object.keys(idOf)
  const idOfUnchanged =
    idOfKeys.length === Object.keys(previous.editorBufferIdOf).length &&
    idOfKeys.every((viewId) => previous.editorBufferIdOf[viewId] === idOf[viewId])
  const recordIds = Object.keys(views)
  const viewsUnchanged =
    recordIds.length === Object.keys(previous.editorBufferViews).length &&
    recordIds.every((recordId) =>
      sameViewIds(previous.editorBufferViews[recordId], views[recordId])
    )
  if (idOfUnchanged && viewsUnchanged) {
    return previous
  }
  return {
    editorBufferIdOf: idOfUnchanged ? previous.editorBufferIdOf : idOf,
    editorBufferViews: viewsUnchanged ? previous.editorBufferViews : views
  }
}

/** Why the index is wrong for `openFiles`, or null when it is consistent. */
export function editorBufferViewIndexMismatch(
  index: EditorBufferViewIndex,
  openFiles: readonly OpenFile[]
): string | null {
  const expected = reconcileEditorBufferViewIndex(index, openFiles)
  return expected === index ? null : 'Editor buffer view index does not match the open editor tabs'
}
