/** Something holding a file's newest content outside `editorDrafts` (a debounce, a document model). */
export type EditorBufferOwner = {
  /** Writes the held content into `editorDrafts`; throws when it cannot be saved. */
  flush: () => void
  /** Whether the owner holds a change `editorDrafts` lacks; owners without it are legacy, last one wins. */
  hasChange?: () => boolean
  /** A half-typed input that autosave must not commit (CSV cell editing). */
  skipOnAutosave?: boolean
  /** Bumped on every change the owner holds, so autosave reschedules without a new draft. */
  version?: () => number
  /** The user discarded the file's unsaved changes ("Reload from disk", "Don't Save"). */
  discard?: () => void
  /** The reload that followed a discard could not read the file. */
  cancelDiscard?: () => void
}

const owners = new Map<string, Set<EditorBufferOwner>>()
const changeListeners = new Set<(fileId: string) => void>()

export function registerEditorBufferOwner(fileId: string, owner: EditorBufferOwner): () => void {
  const entry = { ...owner }
  const entries = owners.get(fileId) ?? new Set<EditorBufferOwner>()
  entries.add(entry)
  owners.set(fileId, entries)
  return () => {
    entries.delete(entry)
    if (!entries.size && owners.get(fileId) === entries) {
      owners.delete(fileId)
    }
  }
}

export function flushPendingEditorChange(fileId: string, autosave = false): void {
  const entries = [...(owners.get(fileId) ?? [])]
  // Keep legacy replacement semantics while retaining each CSV pane's pending input.
  const legacy = entries.findLast((entry) => !entry.hasChange)
  for (const entry of entries) {
    if (entry.hasChange ? !(autosave && entry.skipOnAutosave) : entry === legacy) {
      entry.flush()
    }
  }
}

export function hasPendingEditorChange(fileId: string): boolean {
  return [...(owners.get(fileId) ?? [])].some((entry) => entry.hasChange?.())
}

export function getEditorBufferVersion(fileId: string): number | undefined {
  return [...(owners.get(fileId) ?? [])].find((entry) => entry.version)?.version?.()
}

export function discardEditorBufferChanges(fileId: string): void {
  for (const entry of owners.get(fileId) ?? []) {
    entry.discard?.()
  }
}

export function cancelEditorBufferDiscard(fileId: string): void {
  for (const entry of owners.get(fileId) ?? []) {
    entry.cancelDiscard?.()
  }
}

/** Owners call this on a change that writes no draft, so autosave sees it. */
export function notifyEditorBufferChanged(fileId: string): void {
  for (const listener of changeListeners) {
    listener(fileId)
  }
}

export function subscribeEditorBufferChanges(listener: (fileId: string) => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}
