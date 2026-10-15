import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { notifyEditorBufferPolicyChanged } from './editor-buffer-owners'
import { exceedsBackupLimit } from './ipynb-output-size'
import { parseIpynbDocument, type IpynbDocument } from './ipynb-parse'

type Projection = { text: string; document: IpynbDocument | null; error: string | null }

// The open-file row bounds the cache lifetime; each row retains only its latest exact text.
const projections = new WeakMap<OpenFile, Projection>()

export function projectNotebookDraft(file: OpenFile | undefined, text: string): Projection {
  const cached = file ? projections.get(file) : undefined
  if (cached?.text === text) {
    return cached
  }
  let document: IpynbDocument | null = null
  let error: string | null = null
  try {
    document = parseIpynbDocument(text)
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }
  const projection = { text, document, error }
  if (file) {
    projections.set(file, projection)
  }
  return projection
}

export function canBackUpNotebookDraft(file: OpenFile, text: string): boolean {
  const { document } = projectNotebookDraft(file, text)
  return document === null || !exceedsBackupLimit(document)
}

type HeldNotebook = {
  fileId: string
  baseText: string
  baseDocument: IpynbDocument | null
  view: { document: IpynbDocument | null }
}

export function heldNotebookBackupPolicy(
  entry: HeldNotebook,
  candidate: string | undefined,
  sourceMode: boolean
): boolean | undefined {
  const baseline = entry.baseDocument
  const current = entry.view.document
  if (
    sourceMode ||
    candidate === undefined ||
    candidate !== entry.baseText ||
    !baseline ||
    !current
  ) {
    return undefined
  }
  return !exceedsBackupLimit(baseline) && !exceedsBackupLimit(current)
}

export function currentNotebookBackupPolicy(
  entry: HeldNotebook,
  state: AppState
): boolean | undefined {
  const sourceMode = state.markdownViewMode[entry.fileId] === 'source'
  return heldNotebookBackupPolicy(entry, state.editorDrafts[entry.fileId], sourceMode)
}

export function wakeIfNotebookPolicyChanged(
  entry: HeldNotebook,
  before: boolean | undefined,
  state: AppState
): void {
  if (before !== currentNotebookBackupPolicy(entry, state)) {
    notifyEditorBufferPolicyChanged()
  }
}
