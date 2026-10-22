import type { OpenFile } from '../types/open-file'
import {
  EDITOR_BUFFER_FIELDS,
  editorBufferRecordFromFile,
  isMovedEditorBufferId,
  type EditorBufferRecord,
  type EditorBufferRecords
} from './editor-buffer-record'
import {
  decideEditorBufferJoin,
  isDirtyEditorBufferSide,
  type EditorBufferJoinSide
} from './editor-buffer-join'
import {
  detachedEditorBufferId,
  type EditorBufferDetachments,
  type EditorBufferViewIndex
} from './editor-buffer-views'

export type EditorBufferReconcileState = EditorBufferViewIndex & {
  openFiles: OpenFile[]
  editorBuffers: EditorBufferRecords
  editorDrafts: Record<string, string>
  editorBufferDetached: EditorBufferDetachments
}

type Drafts = Record<string, string>

/** Copy-on-write accumulators for one reconcile pass. */
class ReconcileWrite {
  records: EditorBufferRecords
  drafts: Drafts
  readonly mirrors = new Map<string, EditorBufferRecord>()

  constructor(private readonly input: EditorBufferReconcileState) {
    this.records = input.editorBuffers
    this.drafts = input.editorDrafts
  }

  setRecord(recordId: string, record: EditorBufferRecord): void {
    if (this.records[recordId] === record) {
      return
    }
    this.records = this.records === this.input.editorBuffers ? { ...this.records } : this.records
    this.records[recordId] = record
  }

  /** Writes a view's mirror fields and draft from the record it now belongs to. */
  showView(viewId: string, side: EditorBufferJoinSide): void {
    this.mirrors.set(viewId, side.record)
    if (this.drafts[viewId] === side.draft) {
      return
    }
    this.drafts = this.drafts === this.input.editorDrafts ? { ...this.drafts } : this.drafts
    if (side.draft === undefined) {
      delete this.drafts[viewId]
    } else {
      this.drafts[viewId] = side.draft
    }
  }

  openFiles(): OpenFile[] {
    if (this.mirrors.size === 0) {
      return this.input.openFiles
    }
    let changed = false
    const next = this.input.openFiles.map((file) => {
      const record = this.mirrors.get(file.id)
      if (!record || EDITOR_BUFFER_FIELDS.every((field) => Object.is(file[field], record[field]))) {
        return file
      }
      changed = true
      return { ...file, ...record }
    })
    return changed ? next : this.input.openFiles
  }
}

class IndexBuilder {
  readonly idOf: Record<string, string> = {}
  readonly views: Record<string, string[]> = {}

  place(viewId: string, recordId: string): void {
    this.idOf[viewId] = recordId
    ;(this.views[recordId] ??= []).push(viewId)
  }

  /** Moves every view of `from` to `to`. */
  move(from: string, to: string): void {
    for (const viewId of this.views[from] ?? []) {
      this.place(viewId, to)
    }
    delete this.views[from]
  }

  build(): EditorBufferViewIndex {
    for (const [recordId, viewIds] of Object.entries(this.views)) {
      if (viewIds.length === 0) {
        delete this.views[recordId]
      }
    }
    return { editorBufferIdOf: this.idOf, editorBufferViews: this.views }
  }
}

function sameIndex(a: EditorBufferViewIndex, b: EditorBufferViewIndex): boolean {
  const aIds = Object.keys(a.editorBufferIdOf)
  const aRecords = Object.keys(a.editorBufferViews)
  return (
    aIds.length === Object.keys(b.editorBufferIdOf).length &&
    aIds.every((id) => b.editorBufferIdOf[id] === a.editorBufferIdOf[id]) &&
    aRecords.length === Object.keys(b.editorBufferViews).length &&
    aRecords.every((id) => {
      const other = b.editorBufferViews[id]
      const own = a.editorBufferViews[id]
      return other?.length === own.length && own.every((view, index) => other[index] === view)
    })
  )
}

function sameDetachments(a: EditorBufferDetachments, b: EditorBufferDetachments): boolean {
  const ids = Object.keys(a)
  return ids.length === Object.keys(b).length && ids.every((id) => a[id] === b[id])
}

/**
 * Puts every open view on the record its identity names, running the join rules for each view
 * that moves (opened, hydrated, owner resolved, renamed): `rekey` when no view holds the identity,
 * else attach, adopt (dirty wins), merge or detach. A view arriving by rename carries the file's
 * new content, so it takes the key: a clean target's views attach to it, a dirty target detaches.
 * Returns `state`'s own objects for whatever did not change.
 */
export function reconcileEditorBufferRecords(
  state: EditorBufferReconcileState,
  identityOf: (file: OpenFile) => string
): EditorBufferReconcileState {
  const detached: EditorBufferDetachments = {}
  const desired = new Map<string, string>()
  for (const file of state.openFiles) {
    const identity = identityOf(file)
    const entry = state.editorBufferDetached[file.id]
    // Why: a detachment holds only while the view still names the identity it was kept off.
    if (entry && (entry.retired || entry.key === identity)) {
      detached[file.id] = entry
      desired.set(file.id, entry.recordId)
    } else {
      desired.set(file.id, identity)
    }
  }

  const write = new ReconcileWrite(state)
  const index = new IndexBuilder()
  const kept = new Set<string>()
  const moving: OpenFile[] = []
  const seen = new Set<string>()
  for (const file of state.openFiles) {
    // Why: a degenerate open-file list can repeat an id; both entries are one view.
    if (seen.has(file.id)) {
      continue
    }
    seen.add(file.id)
    const recordId = desired.get(file.id) ?? file.id
    if (
      state.editorBufferIdOf[file.id] === recordId &&
      Object.hasOwn(state.editorBuffers, recordId)
    ) {
      kept.add(file.id)
    } else {
      moving.push(file)
    }
  }
  // Why the previous order: views list in the order they joined.
  for (const [recordId, viewIds] of Object.entries(state.editorBufferViews)) {
    for (const viewId of viewIds) {
      if (
        kept.has(viewId) &&
        index.idOf[viewId] === undefined &&
        state.editorBufferIdOf[viewId] === recordId
      ) {
        index.place(viewId, recordId)
      }
    }
  }
  for (const viewId of kept) {
    if (index.idOf[viewId] === undefined) {
      index.place(viewId, state.editorBufferIdOf[viewId])
    }
  }

  // Source record → where its first moving view landed, so its other views follow without a join.
  const landedFrom = new Map<string, { want: string; landed: string }>()
  for (const file of moving) {
    const want = desired.get(file.id) ?? file.id
    const source = state.editorBufferIdOf[file.id]
    const followed = source === undefined ? undefined : landedFrom.get(source)
    if (followed && followed.want === want) {
      index.place(file.id, followed.landed)
      const firstDetachment = Object.values(detached).find((d) => d.recordId === followed.landed)
      if (firstDetachment) {
        detached[file.id] = firstDetachment
      }
      continue
    }
    const sourceRecord = source === undefined ? undefined : state.editorBuffers[source]
    const joining: EditorBufferJoinSide = {
      record: sourceRecord ?? editorBufferRecordFromFile(file),
      draft: state.editorDrafts[file.id]
    }
    const landed = joinView(file.id, want, joining, source, write, index, detached)
    if (source !== undefined) {
      landedFrom.set(source, { want, landed })
    }
  }

  // Membership: a record with no view left is dropped.
  for (const recordId of Object.keys(write.records)) {
    if (!index.views[recordId]?.length) {
      write.records = write.records === state.editorBuffers ? { ...write.records } : write.records
      delete write.records[recordId]
    }
  }
  const built = index.build()
  const indexSame = sameIndex(built, state)
  return {
    openFiles: write.openFiles(),
    editorBuffers: write.records,
    editorDrafts: write.drafts,
    editorBufferIdOf: indexSame ? state.editorBufferIdOf : built.editorBufferIdOf,
    editorBufferViews: indexSame ? state.editorBufferViews : built.editorBufferViews,
    editorBufferDetached: sameDetachments(detached, state.editorBufferDetached)
      ? state.editorBufferDetached
      : detached
  }
}

/** Joins one moving view onto `want`; returns the record id it lands on. */
function joinView(
  viewId: string,
  want: string,
  joining: EditorBufferJoinSide,
  source: string | undefined,
  write: ReconcileWrite,
  index: IndexBuilder,
  detached: EditorBufferDetachments
): string {
  const targetViews = [...(index.views[want] ?? [])]
  if (targetViews.length === 0) {
    write.setRecord(want, joining.record)
    index.place(viewId, want)
    return want
  }
  const target: EditorBufferJoinSide = {
    record: write.records[want],
    draft: write.drafts[targetViews[0]]
  }
  const adopt = (): string => {
    write.setRecord(want, joining.record)
    for (const targetView of targetViews) {
      write.showView(targetView, joining)
    }
    index.place(viewId, want)
    return want
  }
  if (source !== undefined && isMovedEditorBufferId(source)) {
    if (!isDirtyEditorBufferSide(target)) {
      return adopt()
    }
    // Why: the renamed file replaced the target on disk; its unsaved edits stay on their own record.
    const keptOff = detachedEditorBufferId(targetViews[0])
    write.setRecord(keptOff, target.record)
    index.move(want, keptOff)
    for (const targetView of targetViews) {
      detached[targetView] = { recordId: keptOff, key: want }
    }
    write.setRecord(want, joining.record)
    index.place(viewId, want)
    return want
  }
  switch (decideEditorBufferJoin(target, joining)) {
    case 'rekey':
    case 'adopt':
      return adopt()
    case 'attach': {
      // Why: a clean view that saw the file deleted must not lose the banner by joining a clean record.
      const carriesDeleted =
        joining.record.externalMutation === 'deleted' &&
        target.record.externalMutation === undefined &&
        !isDirtyEditorBufferSide(target)
      const joined = carriesDeleted
        ? { ...target, record: { ...target.record, externalMutation: 'deleted' as const } }
        : target
      if (carriesDeleted) {
        write.setRecord(want, joined.record)
        for (const targetView of targetViews) {
          write.showView(targetView, joined)
        }
      }
      write.showView(viewId, joined)
      index.place(viewId, want)
      return want
    }
    case 'merge':
      // Why: the joining view's mirror must read the record, including its dirty flag.
      write.showView(viewId, target)
      index.place(viewId, want)
      return want
    case 'detach': {
      const keptOff = detachedEditorBufferId(viewId)
      write.setRecord(keptOff, joining.record)
      detached[viewId] = { recordId: keptOff, key: want }
      index.place(viewId, keptOff)
      return keptOff
    }
  }
}
