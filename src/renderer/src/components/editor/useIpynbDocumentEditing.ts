import { useCallback, useEffect, useRef, useSyncExternalStore, type MutableRefObject } from 'react'
import { useAppStore } from '@/store'
import {
  deleteIpynbCell,
  insertIpynbCell,
  moveIpynbCell,
  updateIpynbCellKind,
  updateIpynbCellSource
} from './ipynb-cell-mutations'
import {
  editNotebookDocument,
  getNotebookDocumentView,
  openNotebookDocument,
  reconcileNotebookDocument,
  subscribeNotebookDocument,
  type NotebookDocumentView
} from './ipynb-document-store'
import type { IpynbCell, IpynbCellKind, IpynbDocument } from './ipynb-parse'

const NO_DOCUMENT: NotebookDocumentView = { document: null, error: null }

export function getIpynbCellKey(cell: IpynbCell, index: number): string {
  return cell.id ?? `${index}:${cell.kind}`
}

/** The open notebook's document; it takes in the draft or disk text when others change them. */
export function useIpynbDocument(fileId: string, diskText: string): NotebookDocumentView {
  const draft = useAppStore((state) => state.editorDrafts[fileId])
  openNotebookDocument(fileId, diskText)
  const view = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeNotebookDocument(fileId, listener), [fileId]),
    () => getNotebookDocumentView(fileId) ?? NO_DOCUMENT
  )
  useEffect(() => reconcileNotebookDocument(fileId, diskText), [diskText, draft, fileId])
  return view
}

function cancelStructuralFrames(frameIds: MutableRefObject<number[]>): void {
  for (const frameId of frameIds.current) {
    cancelAnimationFrame(frameId)
  }
  frameIds.current = []
}

function requestStructuralFrame(
  frameIds: MutableRefObject<number[]>,
  callback: FrameRequestCallback
): void {
  let completed = false
  let frameId: number | undefined
  frameId = requestAnimationFrame((timestamp) => {
    completed = true
    if (frameId !== undefined) {
      frameIds.current = frameIds.current.filter((pendingFrameId) => pendingFrameId !== frameId)
    }
    callback(timestamp)
  })
  if (!completed) {
    frameIds.current.push(frameId)
  }
}

type UseIpynbDocumentEditingArgs = {
  fileId: string
  language: string
  onDeactivateEditor: () => void
}

export function useIpynbDocumentEditing({
  fileId,
  language,
  onDeactivateEditor
}: UseIpynbDocumentEditingArgs) {
  const rootRef = useRef<HTMLDivElement>(null)
  const structuralFrameIdsRef = useRef<number[]>([])

  const setRootRef = useCallback((node: HTMLDivElement | null): void => {
    rootRef.current = node
    if (node === null) {
      cancelStructuralFrames(structuralFrameIdsRef)
    }
  }, [])

  const updateCellSource = useCallback(
    (index: number, source: string): void =>
      editNotebookDocument(
        fileId,
        (document) => updateIpynbCellSource(document, index, source),
        'debounced'
      ),
    [fileId]
  )

  const applyStructuralChange = useCallback(
    (edit: (document: IpynbDocument) => IpynbDocument): void => {
      onDeactivateEditor()
      requestStructuralFrame(structuralFrameIdsRef, () => editNotebookDocument(fileId, edit, 'now'))
    },
    [fileId, onDeactivateEditor]
  )

  const updateCellKind = useCallback(
    (index: number, kind: IpynbCellKind): void =>
      applyStructuralChange((document) => updateIpynbCellKind(document, index, kind, language)),
    [applyStructuralChange, language]
  )
  const insertCell = useCallback(
    (index: number, kind: IpynbCellKind): void =>
      applyStructuralChange((document) => insertIpynbCell(document, index, kind, language)),
    [applyStructuralChange, language]
  )
  const moveCell = useCallback(
    (index: number, direction: -1 | 1): void =>
      applyStructuralChange((document) => moveIpynbCell(document, index, direction)),
    [applyStructuralChange]
  )
  const deleteCell = useCallback(
    (index: number): void => applyStructuralChange((document) => deleteIpynbCell(document, index)),
    [applyStructuralChange]
  )

  return {
    rootRef,
    setRootRef,
    updateCellSource,
    updateCellKind,
    insertCell,
    moveCell,
    deleteCell
  }
}
