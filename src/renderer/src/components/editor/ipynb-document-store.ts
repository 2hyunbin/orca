import { useAppStore } from '@/store'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from './editor-autosave'
import { notifyEditorBufferChanged } from './editor-buffer-owners'
import {
  ipynbCellKey,
  sameStoredOutputs,
  serializeIpynbDocument,
  updateIpynbCodeCell
} from './ipynb-cell-mutations'
import type { NotebookOutput } from './ipynb-kernel-outputs'
import { limitRecordedOutput } from './ipynb-output-size'
import { isRecord, parseIpynbDocument, type IpynbDocument } from './ipynb-parse'
import { createNotebookReloadManager, type NotebookReload } from './ipynb-document-reload'
import {
  clearNotebookTimers,
  migrateNotebookOwner,
  registerNotebookOwner,
  runningNotebookKeys,
  scheduleNotebookCompletion,
  scheduleNotebookSourceWrite
} from './ipynb-document-owner-lifecycle'

/** What the viewer draws: the document, or why the newest text can't be shown. */
export type NotebookDocumentView = {
  document: IpynbDocument | null
  error: string | null
}

export type Entry = {
  fileId: string
  view: NotebookDocumentView
  version: number
  /** The version whose text is on disk; null for a restored unsaved draft. */
  savedVersion: number | null
  /** The text the document was last read from or written as, and the document it held. */
  baseText: string
  baseVersion: number
  baseDocument: IpynbDocument | null
  reload: NotebookReload | null
  readEpoch: number
  writeTimer: ReturnType<typeof setTimeout> | null
  completionTimer: ReturnType<typeof setTimeout> | null
  listeners: Set<() => void>
  unregister: () => void
}

// Why module-level and keyed by OpenFile.id: output and edits must land while no viewer is mounted.
const entries = new Map<string, Entry>()

function setView(entry: Entry, document: IpynbDocument | null, error: string | null): void {
  entry.view = { document, error }
  for (const listener of entry.listeners) {
    listener()
  }
}

function openFile(fileId: string) {
  return useAppStore.getState().openFiles.find((file) => file.id === fileId)
}

/** Code cells whose execution result differs from the last text snapshot. */
function unwrittenOutputKeys(entry: Entry): string[] {
  const base = new Map(
    (entry.baseDocument?.cells ?? []).map((cell, index) => [ipynbCellKey(cell, index), cell])
  )
  return (entry.view.document?.cells ?? []).flatMap((cell, index) => {
    const before = base.get(ipynbCellKey(cell, index))
    return isRecord(cell) &&
      cell.cell_type === 'code' &&
      !(
        isRecord(before) &&
        sameStoredOutputs(cell.outputs, before.outputs) &&
        before.execution_count === cell.execution_count
      )
      ? [ipynbCellKey(cell, index)]
      : []
  })
}

/** Replaces the document with `text`, carrying over the output of cells `carryKeys`. */
function adopt(entry: Entry, text: string, clean: boolean, carryKeys: string[]): boolean {
  let next: IpynbDocument
  try {
    next = parseIpynbDocument(text)
  } catch (error) {
    // Why the document stays: it still carries output into the text once that parses.
    setView(entry, entry.view.document, error instanceof Error ? error.message : String(error))
    return false
  }
  const previous = entry.view.document
  entry.version += 1
  entry.baseText = text
  entry.baseVersion = entry.version
  entry.baseDocument = next
  entry.savedVersion = clean ? entry.version : null
  let resultsDiffer = false
  for (const key of previous ? carryKeys : []) {
    const cell = previous?.cells.find((candidate, index) => ipynbCellKey(candidate, index) === key)
    if (isRecord(cell) && Array.isArray(cell.outputs)) {
      const outputs = cell.outputs.filter(isRecord)
      const executionCount = typeof cell.execution_count === 'number' ? cell.execution_count : null
      const onDisk = next.cells.find((candidate, index) => ipynbCellKey(candidate, index) === key)
      if (!isRecord(onDisk) || onDisk.cell_type !== 'code') {
        continue
      }
      resultsDiffer ||=
        onDisk.execution_count !== executionCount || !sameStoredOutputs(outputs, onDisk.outputs)
      // Keep live stream cursors and display IDs even when their saved values match disk.
      next = updateIpynbCodeCell(next, key, { outputs: () => outputs, executionCount })
    }
  }
  setView(entry, next, null)
  if (resultsDiffer) {
    // Why: carried output is not in `text`, so it is unsaved even when `text` is on disk.
    entry.version += 1
    useAppStore.getState().markFileDirty(entry.fileId, true)
  } else {
    entry.baseDocument = next
  }
  return true
}

/** Adopts text another writer produced (Source view, an undo), keeping output it lacks. */
function adoptForeign(entry: Entry, text: string, clean: boolean): boolean {
  const carry = new Set([...unwrittenOutputKeys(entry), ...runningNotebookKeys(entry.fileId)])
  return adopt(entry, text, clean, [...carry])
}

/** Writes the document as the file's draft; a draft it didn't write is adopted first, never overwritten. */
function write(entry: Entry, enteringSourceView = false): void {
  clearNotebookTimers(entry)
  // Why: Source view edits the draft text itself; a save there writes exactly what the user typed.
  if (!enteringSourceView && useAppStore.getState().markdownViewMode[entry.fileId] === 'source') {
    return
  }
  const draft = useAppStore.getState().editorDrafts[entry.fileId]
  if (
    draft !== undefined &&
    (draft !== entry.baseText || entry.view.error !== null) &&
    !adoptForeign(entry, draft, openFile(entry.fileId)?.isDirty !== true)
  ) {
    return
  }
  const { document } = entry.view
  if (!document || entry.version === entry.baseVersion) {
    return
  }
  const text = serializeIpynbDocument(document)
  entry.baseText = text
  entry.baseVersion = entry.version
  entry.baseDocument = document
  useAppStore.getState().setEditorDraft(entry.fileId, text)
}

function writeLogged(entry: Entry, enteringSourceView = false): void {
  try {
    write(entry, enteringSourceView)
  } catch (error) {
    // The document keeps the change and the file stays dirty; a save reports the failure.
    console.error('[notebook] writing the draft failed', error)
  }
}

const reloads = createNotebookReloadManager({
  getEntry: (fileId: string) => entries.get(fileId),
  runningKeys: runningNotebookKeys,
  adopt: (entry: Entry, text: string, keys: string[]) => adopt(entry, text, true, keys),
  write: writeLogged
})
const cancelReload = reloads.cancel
export const beginNotebookReload = reloads.begin
export const notebookReadEpoch = reloads.epoch
export const notebookReloadPending = reloads.pending
export const settleNotebookReload = reloads.settle

function change(entry: Entry, next: IpynbDocument): void {
  if (next === entry.view.document) {
    return
  }
  entry.version += 1
  setView(entry, next, entry.view.error)
  useAppStore.getState().markFileDirty(entry.fileId, true)
  notifyEditorBufferChanged(entry.fileId)
}

/** The open notebook's document, created from its draft (else disk text) the first time it is shown. */
export function openNotebookDocument(fileId: string, diskText: string): NotebookDocumentView {
  const existing = entries.get(fileId)
  if (existing) {
    return existing.view
  }
  const text = useAppStore.getState().editorDrafts[fileId] ?? diskText
  const entry: Entry = {
    fileId,
    view: { document: null, error: null },
    version: 0,
    savedVersion: null,
    baseText: text,
    baseVersion: 0,
    baseDocument: null,
    reload: null,
    readEpoch: 0,
    writeTimer: null,
    completionTimer: null,
    listeners: new Set(),
    unregister: () => {}
  }
  // Why: a restored unsaved draft has no saved version, so it stays dirty until saved.
  adopt(entry, text, openFile(fileId)?.isDirty !== true, [])
  entry.unregister = registerNotebookOwner(entry, write, cancelReload)
  entries.set(fileId, entry)
  return entry.view
}

export function getNotebookDocumentView(fileId: string): NotebookDocumentView | undefined {
  return entries.get(fileId)?.view
}

export function subscribeNotebookDocument(fileId: string, listener: () => void): () => void {
  const listeners = entries.get(fileId)?.listeners
  listeners?.add(listener)
  return () => listeners?.delete(listener)
}

/** Takes in text written by others: a discard's reload, Source-view edits, a clean disk change. */
export function reconcileNotebookDocument(fileId: string, diskText: string): void {
  const entry = entries.get(fileId)
  if (!entry) {
    return
  }
  const state = useAppStore.getState()
  const draft = state.editorDrafts[fileId]
  if (entry.reload) {
    return
  }
  if (draft !== undefined && draft !== entry.baseText) {
    if (adoptForeign(entry, draft, openFile(fileId)?.isDirty !== true)) {
      writeLogged(entry)
    }
    return
  }
  if (draft === undefined && diskText !== entry.baseText && openFile(fileId)?.isDirty !== true) {
    adopt(entry, diskText, true, runningNotebookKeys(fileId))
  }
}

/** An edit from the viewer; source typing writes the draft after a pause, structure at once. */
export function editNotebookDocument(
  fileId: string,
  edit: (document: IpynbDocument) => IpynbDocument,
  writeDraft: 'debounced' | 'now'
): void {
  const entry = entries.get(fileId)
  const document = entry?.view.document
  if (!entry || !document) {
    return
  }
  cancelReload(entry)
  change(entry, edit(document))
  if (writeDraft === 'now') {
    writeLogged(entry)
  } else {
    scheduleNotebookSourceWrite(entry, writeLogged)
  }
}

/** Kernel output and execution state for a code cell; live frames never write the draft. */
export function updateNotebookCellRun(
  fileId: string,
  key: string,
  run: {
    outputs?: (outputs: NotebookOutput[]) => NotebookOutput[]
    executionCount?: number | null
  }
): void {
  const entry = entries.get(fileId)
  const document = entry?.view.document
  if (!entry || !document) {
    return
  }
  const next = updateIpynbCodeCell(document, key, run)
  const accepted = run.outputs ? limitRecordedOutput(document, next, key) : next
  change(entry, accepted)
  if (accepted !== document) {
    entry.reload?.keys.add(key)
  }
}

/** A run finished: publish one snapshot for completions in this window. */
export function writeNotebookDraft(fileId: string): void {
  const entry = entries.get(fileId)
  if (entry) {
    scheduleNotebookCompletion(entry, entries, writeLogged)
  }
}

window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, (event) => {
  const detail: unknown = event instanceof CustomEvent ? event.detail : null
  if (
    !isRecord(detail) ||
    typeof detail.fileId !== 'string' ||
    typeof detail.content !== 'string'
  ) {
    return
  }
  const entry = entries.get(detail.fileId)
  // Why a reference check: text this store wrote needs no parse to know which version is saved.
  if (entry?.baseText === detail.content) {
    entry.savedVersion = entry.baseVersion
  } else if (entry && useAppStore.getState().markdownViewMode[entry.fileId] === 'source') {
    // Saved from Source view, where this store writes nothing: disk holds the user's text.
    adoptForeign(entry, detail.content, true)
  }
})

useAppStore.subscribe((state, previous) => {
  if (state.openFiles !== previous.openFiles) {
    for (const [fileId, entry] of entries) {
      if (!state.openFiles.some((file) => file.id === fileId)) {
        if (migrateNotebookOwner(fileId, entry, entries, state, previous, cancelReload, write)) {
          continue
        }
        clearNotebookTimers(entry)
        cancelReload(entry)
        entry.unregister()
        entries.delete(fileId)
      }
    }
  }
  if (state.markdownViewMode !== previous.markdownViewMode) {
    for (const [fileId, entry] of entries) {
      const inSource = state.markdownViewMode[fileId] === 'source'
      if (inSource !== (previous.markdownViewMode[fileId] === 'source')) {
        // Why: Source view opens on the draft, and on leaving it gets the output that arrived meanwhile.
        writeLogged(entry, inSource)
      }
    }
  }
})
