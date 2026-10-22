import type { StateCreator } from 'zustand'
import {
  editorBufferMirrorMismatch,
  type EditorBufferState
} from './slices/editor/buffers/editor-buffer-record'
import {
  editorBufferIdOfView,
  editorBufferViewIndexMismatch,
  type EditorBufferViewIndex
} from './slices/editor/buffers/editor-buffer-views'
import {
  editorBufferIdForFile,
  editorBufferRouteInputsChanged,
  type EditorBufferRouteState
} from './slices/editor/buffers/editor-buffer-identity-cache'
import { reconcileEditorBufferRecords } from './slices/editor/buffers/editor-buffer-reconcile'

type EditorBufferStoreState = EditorBufferState & EditorBufferRouteState

const NO_DRAFTS: Record<string, string> = {}
const NO_DETACHMENTS = {}

/**
 * Ties editor buffer records and their view index to `openFiles` membership and file identity
 * inside the same write: views of one file share a record, a view whose identity changes (opened,
 * hydrated, owner resolved, renamed, routes changed) joins by the join rules, and a record with no
 * view left is dropped. Field writes go through the record (`writeEditorBuffer`); with
 * `checkInvariant` a write that drifts a view from its record throws.
 */
function reconcileEditorBuffers<TState extends EditorBufferStoreState>(
  state: TState,
  write: TState | Partial<TState>,
  checkInvariant: boolean
): TState | Partial<TState> {
  const openFiles = write.openFiles ?? state.openFiles
  const records = write.editorBuffers ?? state.editorBuffers
  const drafts = write.editorDrafts ?? state.editorDrafts
  const detachments = write.editorBufferDetached ?? state.editorBufferDetached
  if (
    openFiles === state.openFiles &&
    records === state.editorBuffers &&
    detachments === state.editorBufferDetached &&
    !editorBufferRouteInputsChanged(state, write)
  ) {
    // Why only drafts: this runs per keystroke, and nothing else about the views changed.
    if (checkInvariant && drafts !== state.editorDrafts) {
      assertEditorBufferDraftsAgree({ ...state, ...write }, drafts)
    }
    return write
  }
  const routeState: EditorBufferRouteState = { ...state, ...write }
  const input = {
    openFiles,
    editorBuffers: records,
    editorDrafts: drafts ?? NO_DRAFTS,
    editorBufferIdOf: write.editorBufferIdOf ?? state.editorBufferIdOf,
    editorBufferViews: write.editorBufferViews ?? state.editorBufferViews,
    editorBufferDetached: detachments ?? NO_DETACHMENTS
  }
  const next = reconcileEditorBufferRecords(input, (file) =>
    editorBufferIdForFile(file, routeState)
  )
  if (checkInvariant) {
    assertEditorBufferInvariant(next)
  }
  const changed: Partial<EditorBufferState> = {}
  if (next.openFiles !== input.openFiles) {
    changed.openFiles = next.openFiles
  }
  if (next.editorBuffers !== state.editorBuffers) {
    changed.editorBuffers = next.editorBuffers
  }
  if (next.editorDrafts !== input.editorDrafts) {
    changed.editorDrafts = next.editorDrafts
  }
  if (next.editorBufferIdOf !== state.editorBufferIdOf) {
    changed.editorBufferIdOf = next.editorBufferIdOf
  }
  if (next.editorBufferViews !== state.editorBufferViews) {
    changed.editorBufferViews = next.editorBufferViews
  }
  if (next.editorBufferDetached !== input.editorBufferDetached) {
    changed.editorBufferDetached = next.editorBufferDetached
  }
  if (Object.keys(changed).length === 0) {
    return write
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every key in `changed` is an EditorBufferState field TState extends, holding that field's type.
  return { ...write, ...(changed as Partial<TState>) }
}

/** Every view of a shared record holds the same `editorDrafts` entry. */
export function assertEditorBufferDraftsAgree(
  index: EditorBufferViewIndex,
  drafts: Readonly<Record<string, string>> | undefined
): void {
  for (const viewIds of Object.values(index.editorBufferViews)) {
    const [first, ...rest] = viewIds
    const differing = rest.find((id) => !Object.is(drafts?.[first], drafts?.[id]))
    if (differing !== undefined) {
      throw new Error(`Editor draft of ${differing} differs from another view of its record`)
    }
  }
}

/**
 * Against the index: every view's record exists, every record has a view, and every view of a
 * record holds the same mirror fields and the same `editorDrafts` entry.
 */
export function assertEditorBufferRecordsMatchViews(state: EditorBufferState): void {
  const recordIds = new Set(state.openFiles.map((file) => editorBufferIdOfView(state, file.id)))
  const keys = Object.keys(state.editorBuffers)
  if (keys.length !== recordIds.size || keys.some((id) => !recordIds.has(id))) {
    throw new Error('Editor buffer records are not keyed by the open editor tabs')
  }
  for (const file of state.openFiles) {
    const record = state.editorBuffers[editorBufferIdOfView(state, file.id)]
    const field = editorBufferMirrorMismatch(file, record)
    if (field !== null) {
      throw new Error(`Editor buffer mirror "${field}" of ${file.id} differs from its record`)
    }
  }
  assertEditorBufferDraftsAgree(state, state.editorDrafts)
}

/** The index matches the open tabs, and the records match the index. */
export function assertEditorBufferInvariant(state: EditorBufferState): void {
  const indexMismatch = editorBufferViewIndexMismatch(state, state.openFiles)
  if (indexMismatch !== null) {
    throw new Error(indexMismatch)
  }
  assertEditorBufferRecordsMatchViews(state)
}

export function withEditorBufferRecords<TState extends EditorBufferStoreState>(
  createState: StateCreator<TState, [], []>,
  checkInvariant: boolean = import.meta.env.DEV
): StateCreator<TState, [], []> {
  return (set, get, api) => {
    const wrap = (write: typeof set): typeof set => {
      const wrapped = (
        partial: TState | Partial<TState> | ((state: TState) => TState | Partial<TState>),
        replace?: boolean
      ): void => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwards the caller's own partial/replace pair; with replace=true the updater still yields a full state.
        ;(write as (next: (state: TState) => TState | Partial<TState>, replace?: boolean) => void)(
          (state) =>
            reconcileEditorBuffers(
              state,
              typeof partial === 'function' ? partial(state) : partial,
              checkInvariant
            ),
          replace
        )
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: one implementation serves both zustand setState overloads.
      return wrapped as typeof set
    }
    api.setState = wrap(api.setState)
    return createState(wrap(set), get, api)
  }
}
