import { useAppStore } from '@/store'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from './editor-autosave'
import { notifyEditorBufferChanged, registerEditorBufferOwner } from './editor-buffer-owners'
import { updateIpynbCodeCell } from './ipynb-cell-mutations'
import {
  currentNotebookBackupPolicy,
  heldNotebookBackupPolicy,
  projectNotebookDraft,
  wakeIfNotebookPolicyChanged
} from './ipynb-draft-backup'
import { serializeNotebookDraft } from './ipynb-draft-serialization'
import {
  carryNotebookOutput,
  foreignOutputCarryKeys,
  runningNotebookKeys
} from './ipynb-document-reconciliation'
import type { NotebookOutput } from './ipynb-kernel-outputs'
import { exceedsBackupLimit, limitRecordedOutput } from './ipynb-output-size'
import { isRecord, type IpynbDocument } from './ipynb-parse'

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
  entry.listeners.forEach((listener) => listener())
}

const openFile = (fileId: string) =>
  useAppStore.getState().openFiles.find((file) => file.id === fileId)

/** Replaces the document with `text`, carrying over the output of cells `carryKeys`. */
function adopt(entry: Entry, text: string, clean: boolean, carryKeys: string[]): boolean {
  const projection = projectNotebookDraft(openFile(entry.fileId), text)
  if (projection.document === null) {
    // Why the document stays: it still carries output into the text once that parses.
    setView(entry, entry.view.document, projection.error)
    return false
  }
  const baseline = projection.document
  const previousPolicy = currentNotebookBackupPolicy(entry, useAppStore.getState())
  entry.version += 1
  entry.baseText = text
  entry.baseVersion = entry.version
  entry.baseDocument = baseline
  entry.savedVersion = clean ? entry.version : null
  const next = carryNotebookOutput(entry.view.document, baseline, carryKeys)
  setView(entry, next, null)
  if (next !== baseline) {
    // Why: carried output is not in `text`, so it is unsaved even when `text` is on disk.
    entry.version += 1
    useAppStore.getState().markFileDirty(entry.fileId, true)
  }
  wakeIfNotebookPolicyChanged(entry, previousPolicy, useAppStore.getState())
  return true
}

/** Adopts text another writer produced (Source view, an undo), keeping output it lacks. */
function adoptForeign(entry: Entry, text: string, clean: boolean): boolean {
  const candidate = projectNotebookDraft(openFile(entry.fileId), text).document
  const carry = candidate
    ? foreignOutputCarryKeys(
        entry.baseDocument,
        entry.view.document,
        candidate,
        runningNotebookKeys(entry.fileId, openFile(entry.fileId)?.filePath)
      )
    : []
  return adopt(entry, text, clean, carry)
}

function clearWriteTimer(entry: Entry): void {
  if (entry.writeTimer !== null) {
    clearTimeout(entry.writeTimer)
    entry.writeTimer = null
  }
}

/** Flushes (save, autosave, restart, close) and entering Source view need the draft; changes only keep it current. */
type WriteReason = 'flush' | 'entering-source-view' | 'change'

/** Writes the document as the file's draft; a draft it didn't write is adopted first, never overwritten. */
function write(entry: Entry, reason: WriteReason): void {
  clearWriteTimer(entry)
  const { editorDrafts, markdownViewMode } = useAppStore.getState()
  const draft = editorDrafts[entry.fileId]
  // Source keeps its exact text; a save flush reconciles it for dirty accounting.
  if (reason !== 'entering-source-view' && markdownViewMode[entry.fileId] === 'source') {
    if (reason === 'flush' && draft !== undefined && draft !== entry.baseText) {
      adoptForeign(entry, draft, openFile(entry.fileId)?.isDirty !== true)
    }
    return
  }
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
  const text = serializeNotebookDraft(document)
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
  const previousPolicy = currentNotebookBackupPolicy(entry, useAppStore.getState())
  const previousDocument = entry.view.document
  entry.version += 1
  setView(entry, next, entry.view.error)
  useAppStore.getState().markFileDirty(entry.fileId, true)
  if (
    previousDocument &&
    exceedsBackupLimit(previousDocument) &&
    !exceedsBackupLimit(next) &&
    useAppStore.getState().markdownViewMode[entry.fileId] !== 'source'
  ) {
    writeLogged(entry, 'change')
  }
  wakeIfNotebookPolicyChanged(entry, previousPolicy, useAppStore.getState())
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
    canBackUp: (candidate) =>
      heldNotebookBackupPolicy(
        entry,
        candidate,
        useAppStore.getState().markdownViewMode[fileId] === 'source'
      )
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
    if (
      adopt(entry, diskText, true, runningNotebookKeys(fileId, openFile(fileId)?.filePath)) &&
      entry.version === entry.savedVersion
    ) {
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
    adopt(entry, diskText, true, runningNotebookKeys(fileId, openFile(fileId)?.filePath))
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
      const wasSource = previous.markdownViewMode[fileId] === 'source'
      if (inSource !== wasSource) {
        const draft = state.editorDrafts[fileId]
        const priorPolicy = heldNotebookBackupPolicy(entry, draft, wasSource)
        // Why: Source view opens on the draft, and on leaving it gets the output that arrived meanwhile.
        writeLogged(entry, inSource ? 'entering-source-view' : 'change')
        wakeIfNotebookPolicyChanged(entry, priorPolicy, useAppStore.getState())
      }
    }
  }
})
