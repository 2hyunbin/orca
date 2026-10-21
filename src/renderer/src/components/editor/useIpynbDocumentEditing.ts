import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject
} from 'react'
import { registerPendingEditorFlush } from './editor-pending-flush'
import { notifyStaleViewEditRejected } from './editor-stale-view-edit'
import {
  deleteIpynbCell,
  insertIpynbCell,
  moveIpynbCell,
  updateIpynbCellKind,
  updateIpynbCellSources
} from './ipynb-cell-mutations'
import type { IpynbCell, IpynbCellKind, ParsedIpynb } from './ipynb-parse'

const NOTEBOOK_SOURCE_COMMIT_DELAY_MS = 400

export function getIpynbCellKey(cell: IpynbCell, index: number): string {
  return cell.id ?? `${index}:${cell.kind}`
}

export function hasIpynbSourceDraft(drafts: Record<string, string>, key: string): boolean {
  return Object.hasOwn(drafts, key)
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
  content: string
  fileId: string
  notebook: ParsedIpynb | null
  onContentChange: (content: string) => void
  onDirtyStateHint: (dirty: boolean) => void
  onDeactivateEditor: () => void
}

export function useIpynbDocumentEditing({
  content,
  fileId,
  notebook,
  onContentChange,
  onDirtyStateHint,
  onDeactivateEditor
}: UseIpynbDocumentEditingArgs) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [sourceDrafts, setSourceDrafts] = useState<Record<string, string>>({})
  const sourceDraftsRef = useRef(sourceDrafts)
  const contentRef = useRef(content)
  const notebookRef = useRef(notebook)
  const onContentChangeRef = useRef(onContentChange)
  const onDirtyStateHintRef = useRef(onDirtyStateHint)
  const sourceCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Why: the notebook text the pending drafts were typed against; a commit onto newer text is refused.
  const draftBaseRef = useRef<string | null>(null)
  const structuralFrameIdsRef = useRef<number[]>([])
  useLayoutEffect(() => {
    contentRef.current = content
    notebookRef.current = notebook
    onContentChangeRef.current = onContentChange
    onDirtyStateHintRef.current = onDirtyStateHint
  }, [content, notebook, onContentChange, onDirtyStateHint])

  const materializeSourceDrafts = useCallback((): string => {
    const latestNotebook = notebookRef.current
    const drafts = sourceDraftsRef.current
    if (!latestNotebook || Object.keys(drafts).length === 0) {
      return contentRef.current
    }
    const updates = latestNotebook.cells
      .map((cell, index) => {
        const key = getIpynbCellKey(cell, index)
        return hasIpynbSourceDraft(drafts, key) ? { index, source: drafts[key] ?? '' } : null
      })
      .filter((update): update is { index: number; source: string } => update !== null)
    return updateIpynbCellSources(contentRef.current, updates)
  }, [])

  const flushSourceDrafts = useCallback((): string => {
    if (sourceCommitTimerRef.current !== null) {
      clearTimeout(sourceCommitTimerRef.current)
      sourceCommitTimerRef.current = null
    }
    const base = draftBaseRef.current
    draftBaseRef.current = null
    if (base !== null && base !== contentRef.current) {
      sourceDraftsRef.current = {}
      setSourceDrafts({})
      notifyStaleViewEditRejected()
      return contentRef.current
    }
    const nextContent = materializeSourceDrafts()
    if (nextContent !== contentRef.current) {
      contentRef.current = nextContent
      onContentChangeRef.current(nextContent)
    }
    return nextContent
  }, [materializeSourceDrafts])

  const queueSourceDraftCommit = useCallback((): void => {
    if (sourceCommitTimerRef.current !== null) {
      clearTimeout(sourceCommitTimerRef.current)
    }
    sourceCommitTimerRef.current = setTimeout(() => {
      void flushSourceDrafts()
    }, NOTEBOOK_SOURCE_COMMIT_DELAY_MS)
  }, [flushSourceDrafts])

  useEffect(
    () => registerPendingEditorFlush(fileId, flushSourceDrafts),
    [fileId, flushSourceDrafts]
  )

  useEffect(() => {
    if (!notebook || Object.keys(sourceDraftsRef.current).length === 0) {
      return
    }
    const nextDrafts = { ...sourceDraftsRef.current }
    let changed = false
    for (const [index, cell] of notebook.cells.entries()) {
      const key = getIpynbCellKey(cell, index)
      if (hasIpynbSourceDraft(nextDrafts, key) && nextDrafts[key] === cell.source) {
        delete nextDrafts[key]
        changed = true
      }
    }
    if (changed) {
      sourceDraftsRef.current = nextDrafts
      setSourceDrafts(nextDrafts)
    }
  }, [notebook])

  const setRootRef = useCallback(
    (node: HTMLDivElement | null): void => {
      rootRef.current = node
      if (node !== null) {
        return
      }
      void flushSourceDrafts()
      cancelStructuralFrames(structuralFrameIdsRef)
    },
    [flushSourceDrafts]
  )

  const flushOnFocusLeave = useCallback(
    (event: { currentTarget: Element; relatedTarget: EventTarget | null }): void => {
      const next = event.relatedTarget
      if (
        sourceCommitTimerRef.current === null ||
        (next instanceof Node && event.currentTarget.contains(next))
      ) {
        return
      }
      // Why: commit before focus reaches another view of this file, so alternating views never goes stale.
      void flushSourceDrafts()
    },
    [flushSourceDrafts]
  )

  const applyContent = useCallback((nextContent: string): void => {
    if (draftBaseRef.current === contentRef.current) {
      draftBaseRef.current = nextContent
    }
    contentRef.current = nextContent
    onContentChangeRef.current(nextContent)
  }, [])

  const updateCellSource = useCallback(
    (index: number, source: string): void => {
      const cell = notebookRef.current?.cells[index]
      if (!cell) {
        return
      }
      const key = getIpynbCellKey(cell, index)
      draftBaseRef.current ??= contentRef.current
      const nextDrafts = { ...sourceDraftsRef.current, [key]: source }
      sourceDraftsRef.current = nextDrafts
      setSourceDrafts(nextDrafts)
      onDirtyStateHintRef.current(true)
      queueSourceDraftCommit()
    },
    [queueSourceDraftCommit]
  )

  const applyStructuralChange = useCallback(
    (getNextContent: (latestContent: string) => string): void => {
      const latestContent = flushSourceDrafts()
      onDeactivateEditor()
      requestStructuralFrame(structuralFrameIdsRef, () => {
        applyContent(getNextContent(latestContent))
      })
    },
    [applyContent, flushSourceDrafts, onDeactivateEditor]
  )

  const updateCellKind = (index: number, kind: IpynbCellKind): void => {
    const language = notebookRef.current?.language ?? 'python'
    applyStructuralChange((latestContent) =>
      updateIpynbCellKind(latestContent, index, kind, language)
    )
  }
  const insertCell = (index: number, kind: IpynbCellKind): void => {
    const language = notebookRef.current?.language ?? 'python'
    applyStructuralChange((latestContent) => insertIpynbCell(latestContent, index, kind, language))
  }
  const moveCell = (index: number, direction: -1 | 1): void => {
    applyStructuralChange((latestContent) => moveIpynbCell(latestContent, index, direction))
  }
  const deleteCell = (index: number): void => {
    applyStructuralChange((latestContent) => deleteIpynbCell(latestContent, index))
  }

  return {
    rootRef,
    setRootRef,
    flushOnFocusLeave,
    sourceDrafts,
    flushSourceDrafts,
    applyContent,
    updateCellSource,
    updateCellKind,
    insertCell,
    moveCell,
    deleteCell
  }
}
