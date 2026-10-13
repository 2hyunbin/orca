import { describe, expect, it, vi } from 'vitest'
import { createEditorStore } from './editor-slice-test-harness'
import type { OpenFile } from './editor/types/open-file'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const file: Omit<OpenFile, 'id' | 'isDirty'> = {
  filePath: '/repo/output.log',
  relativePath: 'output.log',
  worktreeId: 'wt-1',
  runtimeEnvironmentId: null,
  language: 'plaintext',
  mode: 'plugin-viewer',
  pluginViewer: {
    key: 'viewer:community.logs/text',
    sourceView: { readOnly: false },
    viewport: { kind: 'text', startLine: 64, lineCount: 64 }
  }
}

describe('plugin viewer source intent', () => {
  it('forces the parser tab readonly and rejects dirty drafts even without a caller flag', () => {
    const store = createEditorStore()
    const id = store.getState().openFile({ ...file, readOnly: false, liveTail: true })
    store.getState().markFileDirty(id, true)
    store.getState().setEditorDraft(id, 'unauthorized edit')
    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({ id, readOnly: true, liveTail: undefined, isDirty: false })
    ])
    expect(store.getState().editorDrafts[id]).toBeUndefined()
  })

  it('updates the source intent of a reused parser without dropping its viewport', () => {
    const store = createEditorStore()
    const id = store.getState().openFile(file, { preview: false })
    const reused = store.getState().openFile(
      {
        ...file,
        pluginViewer: {
          key: file.pluginViewer!.key,
          sourceView: { readOnly: true, liveTail: true }
        }
      },
      { preview: false }
    )
    expect(reused).toBe(id)
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0]?.pluginViewer).toEqual({
      ...file.pluginViewer,
      sourceView: { readOnly: true, liveTail: true }
    })
    store.getState().openFile(file, { preview: false })
    expect(store.getState().openFiles[0]?.pluginViewer?.sourceView).toEqual({ readOnly: false })
    expect(store.getState().openFiles[0]?.readOnly).toBe(true)
  })

  it('rehydrates source restrictions while ignoring a corrupt parser draft', () => {
    const store = createEditorStore()
    store.getState().hydrateEditorSession({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        'wt-1': [
          {
            filePath: file.filePath,
            relativePath: file.relativePath,
            worktreeId: file.worktreeId,
            language: file.language,
            pluginViewer: { ...file.pluginViewer!, sourceView: { readOnly: true, liveTail: true } },
            dirtyDraftContent: 'must not restore',
            readOnly: false
          }
        ]
      }
    })
    const restored = store.getState().openFiles[0]
    expect(restored).toMatchObject({
      mode: 'plugin-viewer',
      readOnly: true,
      isDirty: false,
      pluginViewer: { sourceView: { readOnly: true, liveTail: true } }
    })
    expect(store.getState().editorDrafts[restored.id]).toBeUndefined()
  })
})
