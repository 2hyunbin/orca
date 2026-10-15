// Why: notebook tests mock '@/store' with this; the real store pulls in the whole app.
import { create } from 'zustand'
import type { MarkdownViewMode } from '@/store/slices/editor'
import type { AppStoreApi } from './editor-save-queue'

type NotebookTestFile = { id: string; filePath: string; worktreeId: string; isDirty: boolean }

type NotebookTestAppState = {
  openFiles: NotebookTestFile[]
  editorDrafts: Record<string, string>
  markdownViewMode: Record<string, MarkdownViewMode>
  worktreesByRepo: Record<string, never[]>
  settings: undefined
  editorFontZoomLevel: number
  setEditorDraft: (fileId: string, content: string) => void
  clearEditorDraft: (fileId: string) => void
  markFileDirty: (fileId: string, dirty: boolean) => void
  setMarkdownViewMode: (fileId: string, mode: MarkdownViewMode) => void
  setLastKnownDiskSignature: () => void
  clearPendingDiskBaselineVerification: () => void
  setExternalMutation: () => void
}

export const notebookTestAppStore = create<NotebookTestAppState>()((set) => ({
  openFiles: [],
  editorDrafts: {},
  markdownViewMode: {},
  worktreesByRepo: {},
  settings: undefined,
  editorFontZoomLevel: 0,
  setEditorDraft: (fileId, content) =>
    set((state) => ({ editorDrafts: { ...state.editorDrafts, [fileId]: content } })),
  clearEditorDraft: (fileId) =>
    set((state) => {
      const { [fileId]: _cleared, ...editorDrafts } = state.editorDrafts
      return { editorDrafts }
    }),
  markFileDirty: (fileId, dirty) =>
    set((state) =>
      state.openFiles.some((file) => file.id === fileId && file.isDirty !== dirty)
        ? {
            openFiles: state.openFiles.map((file) =>
              file.id === fileId ? { ...file, isDirty: dirty } : file
            )
          }
        : state
    ),
  setMarkdownViewMode: (fileId, mode) =>
    set((state) => ({ markdownViewMode: { ...state.markdownViewMode, [fileId]: mode } })),
  setLastKnownDiskSignature: () => {},
  clearPendingDiskBaselineVerification: () => {},
  setExternalMutation: () => {}
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the save queue reads only openFiles, editorDrafts, worktreesByRepo and the actions defined above.
export const notebookTestSaveQueueStore = notebookTestAppStore as unknown as AppStoreApi

/** Opens `fileId` as the only tab, with no draft. */
export function openNotebookTestFile(fileId: string, filePath = `/repo/${fileId}.ipynb`): void {
  notebookTestAppStore.setState({
    openFiles: [{ id: fileId, filePath, worktreeId: 'wt-1', isDirty: false }],
    editorDrafts: {},
    markdownViewMode: {}
  })
}

export function isNotebookTestFileDirty(fileId: string): boolean {
  return notebookTestAppStore
    .getState()
    .openFiles.some((file) => file.id === fileId && file.isDirty)
}
