import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { editorBufferViewIds } from '@/store/slices/editor/buffers/editor-buffer-record'
import type { FileContent } from './editor-panel-content-types'

type BufferContentListener = (sourceFileId: string, content: FileContent) => void

const listeners = new Set<BufferContentListener>()

function isFreshText(content: FileContent | undefined): content is FileContent {
  return content !== undefined && !content.loadError && content.isStale !== true
}

/**
 * Why: tabs of one buffer record share one Monaco model, and a mounting editor reconciles that
 * model to its panel's cached disk text. Each panel caches per tab, so when one panel learns new
 * disk text (load, reload, save) every panel's cache for the same record must follow, or a stale
 * cache would push old text back into the shared model.
 */
export function useEditorBufferContentSync(
  fileContents: Record<string, FileContent>,
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>,
  openFilesRef: { current: OpenFile[] },
  /** Discards this panel's in-flight read of a tab, so it can't land after newer text. */
  supersedeRead?: (fileId: string) => void
): void {
  const previousRef = useRef(fileContents)
  // Entries this panel received from another panel; re-publishing them would echo.
  const receivedRef = useRef(new WeakSet<FileContent>())

  useEffect(() => {
    const listener: BufferContentListener = (sourceFileId, content) => {
      const ids = editorBufferViewIds(useAppStore.getState(), sourceFileId)
      receivedRef.current.add(content)
      for (const id of ids) {
        if (previousRef.current[id] !== content) {
          supersedeRead?.(id)
        }
      }
      setFileContents((prev) => {
        let next = prev
        for (const id of ids) {
          const existing = prev[id]
          if (!existing || existing === content || isSameText(existing, content)) {
            continue
          }
          next = next === prev ? { ...prev } : next
          next[id] = content
        }
        return next
      })
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [setFileContents, supersedeRead])

  useEffect(() => {
    const previous = previousRef.current
    previousRef.current = fileContents
    if (previous === fileContents) {
      return
    }
    for (const [fileId, content] of Object.entries(fileContents)) {
      if (
        content === previous[fileId] ||
        !isFreshText(content) ||
        receivedRef.current.has(content) ||
        openFilesRef.current.find((file) => file.id === fileId)?.mode !== 'edit'
      ) {
        continue
      }
      for (const listener of listeners) {
        listener(fileId, content)
      }
    }
  }, [fileContents, openFilesRef])
}

function isSameText(a: FileContent, b: FileContent): boolean {
  return a.isStale !== true && a.content === b.content && a.isBinary === b.isBinary
}
