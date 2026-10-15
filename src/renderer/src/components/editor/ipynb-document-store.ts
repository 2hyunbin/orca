import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from './editor-autosave'
import { notifyEditorBufferChanged, registerEditorBufferOwner } from './editor-buffer-owners'
import { ipynbCellKey, serializeIpynbDocument, updateIpynbCodeCell } from './ipynb-cell-mutations'
import type { NotebookOutput } from './ipynb-kernel-outputs'
import { getSession, runningCellKey } from './ipynb-kernel-store'
import { exceedsBackupLimit, limitRecordedOutput } from './ipynb-output-size'
import { isRecord, parseIpynbDocument, type IpynbDocument } from './ipynb-parse'

const DRAFT_WRITE_DELAY_MS = 400

/** What the viewer draws: the document, or why the newest text can't be shown. */
export type NotebookDocumentView = {
  document: IpynbDocument | null
  error: string | null
}

type Entry = {
  fileId: string
  view: NotebookDocumentView
  version: number
  /** The version whose text is on disk; null for a restored unsaved draft. */
  savedVersion: number | null
  /** The text the document was last read from or written as, and the document it held. */
  baseText: string
  baseVersion: number
  baseDocument: IpynbDocument | null
  /** Discard was asked for: the next disk text the viewer reports replaces the document. */
  discardPending: boolean
  writeTimer: ReturnType<typeof setTimeout> | null
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

/** The cell whose run is still writing into this file's document, if any. */
function runningKeys(fileId: string): string[] {
  const filePath = openFile(fileId)?.filePath
  const session = filePath === undefined ? null : getSession(filePath)
  const key = session ? runningCellKey(session) : null
  return key !== null && session?.runs[key]?.fileId === fileId ? [key] : []
}

/** Code cells whose output arrived after the document was last read or written. */
function unwrittenOutputKeys(entry: Entry): string[] {
  const base = new Map(
    (entry.baseDocument?.cells ?? []).map((cell, index) => [ipynbCellKey(cell, index), cell])
  )
  return (entry.view.document?.cells ?? []).flatMap((cell, index) => {
    const before = base.get(ipynbCellKey(cell, index))
    return isRecord(cell) &&
      cell.cell_type === 'code' &&
      !(isRecord(before) && before.outputs === cell.outputs)
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
  for (const key of previous ? carryKeys : []) {
    const cell = previous?.cells.find((candidate, index) => ipynbCellKey(candidate, index) === key)
    if (isRecord(cell) && Array.isArray(cell.outputs)) {
      const outputs = cell.outputs.filter(isRecord)
      const executionCount = typeof cell.execution_count === 'number' ? cell.execution_count : null
      next = updateIpynbCodeCell(next, key, { outputs: () => outputs, executionCount })
    }
  }
  setView(entry, next, null)
  if (next !== entry.baseDocument) {
    // Why: carried output is not in `text`, so it is unsaved even when `text` is on disk.
    entry.version += 1
    useAppStore.getState().markFileDirty(entry.fileId, true)
  }
  return true
}

/** Adopts text another writer produced (Source view, an undo), keeping output it lacks. */
function adoptForeign(entry: Entry, text: string, clean: boolean): boolean {
  const carry = new Set([...unwrittenOutputKeys(entry), ...runningKeys(entry.fileId)])
  return adopt(entry, text, clean, [...carry])
}

function clearWriteTimer(entry: Entry): void {
  if (entry.writeTimer !== null) {
    clearTimeout(entry.writeTimer)
    entry.writeTimer = null
  }
}

function serialize(document: IpynbDocument): string {
  try {
    return serializeIpynbDocument(document)
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(
        translate(
          'auto.components.editor.IpynbViewer.tooLargeToSave',
          'This notebook is too large to save.'
        )
      )
    }
    throw error
  }
}

/** Flushes (save, autosave, restart, close) and entering Source view need the draft; changes only keep it current. */
type WriteReason = 'flush' | 'entering-source-view' | 'change'

/** Writes the document as the file's draft; a draft it didn't write is adopted first, never overwritten. */
function write(entry: Entry, reason: WriteReason): void {
  clearWriteTimer(entry)
  const { editorDrafts, markdownViewMode } = useAppStore.getState()
  // Why: Source view edits the draft text itself; a save there writes exactly what the user typed.
  if (reason !== 'entering-source-view' && markdownViewMode[entry.fileId] === 'source') {
    return
  }
  const draft = editorDrafts[entry.fileId]
  if (
    draft !== undefined &&
    draft !== entry.baseText &&
    !adoptForeign(entry, draft, openFile(entry.fileId)?.isDirty !== true)
  ) {
    return
  }
  const { document } = entry.view
  if (!document || entry.version === entry.baseVersion) {
    return
  }
  // Why: a restart doesn't back this notebook up, so only a flush pays for the whole-notebook text.
  if (reason === 'change' && exceedsBackupLimit(document)) {
    return
  }
  const text = serialize(document)
  entry.baseText = text
  entry.baseVersion = entry.version
  entry.baseDocument = document
  useAppStore.getState().setEditorDraft(entry.fileId, text)
}

function writeLogged(entry: Entry, reason: WriteReason): void {
  try {
    write(entry, reason)
  } catch (error) {
    // The document keeps the change and the file stays dirty; a save reports the failure.
    console.error('[notebook] writing the draft failed', error)
  }
}

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
    discardPending: false,
    writeTimer: null,
    listeners: new Set(),
    unregister: () => {}
  }
  // Why: a restored unsaved draft has no saved version, so it stays dirty until saved.
  adopt(entry, text, openFile(fileId)?.isDirty !== true, [])
  entry.unregister = registerEditorBufferOwner(fileId, {
    flush: () => write(entry, 'flush'),
    hasChange: () => entry.view.document !== null && entry.version !== entry.baseVersion,
    version: () => entry.version,
    discard: () => {
      clearWriteTimer(entry)
      entry.discardPending = true
    },
    cancelDiscard: () => {
      entry.discardPending = false
    },
    canBackUp: () => !entry.view.document || !exceedsBackupLimit(entry.view.document)
  })
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
  if (entry.discardPending) {
    entry.discardPending = false
    // Why: a draft this store wrote while the reload was in flight holds the discarded changes.
    if (draft === entry.baseText) {
      state.clearEditorDraft(fileId)
    }
    // Output a running cell sent meanwhile re-dirtied the file; with nothing carried it is clean again.
    if (adopt(entry, diskText, true, runningKeys(fileId)) && entry.version === entry.savedVersion) {
      state.markFileDirty(fileId, false)
    }
    return
  }
  if (draft !== undefined && draft !== entry.baseText) {
    if (adoptForeign(entry, draft, openFile(fileId)?.isDirty !== true)) {
      writeLogged(entry, 'change')
    }
    return
  }
  if (draft === undefined && diskText !== entry.baseText && openFile(fileId)?.isDirty !== true) {
    adopt(entry, diskText, true, runningKeys(fileId))
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
  change(entry, edit(document))
  if (writeDraft === 'now') {
    writeLogged(entry, 'change')
  } else {
    clearWriteTimer(entry)
    entry.writeTimer = setTimeout(() => writeLogged(entry, 'change'), DRAFT_WRITE_DELAY_MS)
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
  change(entry, run.outputs ? limitRecordedOutput(document, next, key) : next)
}

/** A run finished: its outputs become part of the draft (over the backup limit, at the next flush), shown or not. */
export function writeNotebookDraft(fileId: string): void {
  const entry = entries.get(fileId)
  if (entry) {
    writeLogged(entry, 'change')
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
        clearWriteTimer(entry)
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
        writeLogged(entry, inSource ? 'entering-source-view' : 'change')
      }
    }
  }
})
