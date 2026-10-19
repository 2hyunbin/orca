import { describe, expect, it } from 'vitest'
import { isAutosaveSuspendedForFile } from '@/components/editor/editor-autosave'
import { createEditorStore } from './editor-slice-test-harness'

describe('autosave pause after an undone reload across restart', () => {
  it('restores the pause with the hot-exit draft, so autosave cannot write it', () => {
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
            filePath: '/repo/notes.md',
            relativePath: 'notes.md',
            worktreeId: 'wt-1',
            language: 'markdown',
            dirtyDraftContent: 'pre-reload text',
            autosavePausedAfterReloadUndo: true
          }
        ]
      }
    })

    const restored = store.getState().openFiles.find((f) => f.filePath === '/repo/notes.md')
    expect(restored?.autosavePausedAfterReloadUndo).toEqual(expect.any(Number))
    expect(restored && isAutosaveSuspendedForFile(restored)).toBe(true)
  })
})
