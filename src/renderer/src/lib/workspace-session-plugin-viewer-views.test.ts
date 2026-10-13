import { describe, expect, it } from 'vitest'
import { buildEditorSessionData } from './workspace-session'
import { createEditorTabsStore } from '@/store/slices/editor-slice-test-harness'
import { persistedOpenFileSchema } from '../../../shared/workspace-session-editor-schema'
import type { OpenFile } from '@/store/slices/editor'

describe('viewer pane positions across session persistence', () => {
  it('round-trips independent tab positions without persisting expired authority or drafts', () => {
    const pluginViewer = {
      key: 'viewer:community.viewer/sample',
      sourceView: { readOnly: false },
      viewportsByTab: {
        left: { kind: 'text' as const, startLine: 0, lineCount: 64 },
        right: { kind: 'text' as const, startLine: 64, lineCount: 64 }
      }
    }
    const file: OpenFile = {
      id: 'viewer-file',
      worktreeId: 'wt-1',
      filePath: '/repo/file.binary',
      relativePath: 'file.binary',
      language: 'plaintext',
      mode: 'plugin-viewer',
      isDirty: true,
      pluginViewer,
      pluginViewerOwnerExpired: true,
      fileContentReloadNonce: 4
    }
    const payload = buildEditorSessionData([file], { [file.id]: 'discard' }, {}, {}, {})
    const persisted = payload.openFilesByWorktree!['wt-1']![0]!
    expect(persistedOpenFileSchema.parse(persisted).pluginViewer).toEqual(pluginViewer)
    expect(persisted).not.toHaveProperty('pluginViewerOwnerExpired')
    expect(persisted).not.toHaveProperty('fileContentReloadNonce')
    expect(persisted).not.toHaveProperty('dirtyDraftContent')
    const store = createEditorTabsStore()
    store.getState().hydrateEditorSession({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      ...payload
    })
    expect(store.getState().openFiles[0]).toMatchObject({
      pluginViewer,
      readOnly: true,
      isDirty: false
    })
    expect(store.getState().openFiles[0]?.pluginViewerOwnerExpired).toBeUndefined()
  })
})
