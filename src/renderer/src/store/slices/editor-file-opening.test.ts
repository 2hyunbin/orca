import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'
import { usePluginFileViewerStore } from '../plugin-file-viewers'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { OpenFile } from './editor/types/open-file'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
const viewer = {
  key: 'viewer:community.viewer/sample',
  pluginKey: 'community.viewer',
  pluginName: 'Sample',
  id: 'sample',
  displayName: 'Sample viewer',
  revision: 'release-1',
  generation: 1,
  selector: [{ filenamePattern: '*.sample' }],
  rendering: 'host-ui' as const,
  mode: 'readonly' as const
}
const input: Omit<OpenFile, 'id' | 'isDirty'> = {
  filePath: '/repo/file.sample',
  relativePath: 'file.sample',
  worktreeId: 'wt-1',
  language: 'plaintext',
  mode: 'edit',
  runtimeEnvironmentId: null
}
const makeStore = () => {
  const store = createEditorTabsStore()
  store.setState({ settings: createGlobalSettingsFixture({ pluginViewerAssociations: [] }) })
  return store
}
beforeEach(() => {
  vi.stubGlobal('window', { api: { plugins: { listFileViewers: vi.fn() } } })
  usePluginFileViewerStore.setState({ status: 'loading', viewers: [], syntaxPacks: [] })
})
afterEach(() => {
  vi.unstubAllGlobals()
  usePluginFileViewerStore.setState({ status: 'idle', viewers: [], syntaxPacks: [] })
})
describe('waiting file tabs and atomic viewer resolution', () => {
  it('refuses core resolution and preserves selected-file intent across viewer choice', () => {
    const store = makeStore()
    usePluginFileViewerStore.setState({ status: 'ready', viewers: [viewer], syntaxPacks: [] })
    const id = store
      .getState()
      .openFile({
        ...input,
        mode: 'file-opening',
        readOnly: true,
        pluginViewerUserSelectedFile: true,
        fileOpening: { readOnly: true }
      })
    expect(store.getState().resolveFileOpening(id, 'core')).toBe(false)
    expect(store.getState().resolveFileOpening(id, viewer.key)).toBe(true)
    expect(store.getState().openFiles[0]).toMatchObject({
      mode: 'plugin-viewer',
      readOnly: true,
      pluginViewerUserSelectedFile: true
    })
  })
  it('creates a neutral readonly tab until approved metadata is available', () => {
    const store = makeStore()
    const id = store.getState().openFile(input)
    expect(id).toMatch(/^file-opening:/)
    expect(store.getState().openFiles[0]).toMatchObject({
      mode: 'file-opening',
      readOnly: true,
      fileOpening: { readOnly: false },
      fileOpeningChoicePending: false
    })
    store.getState().markFileDirty(id, true)
    store.getState().setEditorDraft(id, 'must not read or edit')
    expect(store.getState().openFiles[0]?.isDirty).toBe(false)
    expect(store.getState().editorDrafts[id]).toBeUndefined()
    expect(store.getState().resolveFileOpening(id, viewer.key)).toBe(false)
  })
  it('retargets the waiting tab in its original split, preserving pin, preview, order and layout', () => {
    const store = makeStore()
    store.setState({
      groupsByWorktree: {
        'wt-1': [
          { id: 'left', worktreeId: 'wt-1', activeTabId: null, tabOrder: [] },
          { id: 'right', worktreeId: 'wt-1', activeTabId: null, tabOrder: [] }
        ]
      },
      layoutByWorktree: {
        'wt-1': {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'left' },
          second: { type: 'leaf', groupId: 'right' }
        }
      }
    })
    const id = store.getState().openFile(input, { targetGroupId: 'right', preview: true })
    const original = store.getState().unifiedTabsByWorktree['wt-1']![0]!
    store.setState({ unifiedTabsByWorktree: { 'wt-1': [{ ...original, isPinned: true }] } })
    const layout = store.getState().layoutByWorktree
    usePluginFileViewerStore.setState({ status: 'ready', viewers: [viewer] })
    expect(store.getState().resolveFileOpening(id, viewer.key)).toBe(true)
    const next = store.getState().openFiles[0]!
    expect(next).toMatchObject({
      mode: 'plugin-viewer',
      readOnly: true,
      pluginViewer: { key: viewer.key, sourceView: { readOnly: false } }
    })
    const tab = store.getState().unifiedTabsByWorktree['wt-1']![0]!
    expect(tab).toMatchObject({
      entityId: next.id,
      groupId: 'right',
      isPinned: true,
      isPreview: original.isPreview
    })
    expect(
      store.getState().groupsByWorktree['wt-1']!.find((group) => group.id === 'right')
    ).toMatchObject({ activeTabId: tab.id, tabOrder: [tab.id] })
    expect(store.getState().layoutByWorktree).toBe(layout)
  })
  it('merges with an existing core tab without overwriting dirty content or duplicating same-pane tabs', () => {
    const store = makeStore()
    const coreId = store.getState().openFile(input, { preview: false, fileViewer: 'core' })
    store.getState().setEditorDraft(coreId, 'unsaved user text')
    store.getState().markFileDirty(coreId, true)
    const id = store.getState().openFile(input, { preview: false })
    expect(id).not.toBe(coreId)
    store.setState({ editorCursorLine: { [coreId]: 88, [id]: 1 } })
    expect(store.getState().resolveFileOpening(id, 'core')).toBe(true)
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().editorDrafts[coreId]).toBe('unsaved user text')
    expect(store.getState().openFiles[0]?.isDirty).toBe(true)
    expect(store.getState().editorCursorLine).toEqual({ [coreId]: 88 })
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toHaveLength(1)
    const tab = store.getState().unifiedTabsByWorktree['wt-1']![0]!
    expect(store.getState().groupsByWorktree['wt-1']![0]).toMatchObject({
      activeTabId: tab.id,
      tabOrder: [tab.id]
    })
  })
  it('cannot resolve a closed source or a changed workspace owner', () => {
    const store = makeStore()
    const id = store.getState().openFile(input)
    store.getState().closeFile(id)
    usePluginFileViewerStore.setState({ status: 'ready', viewers: [viewer] })
    expect(store.getState().resolveFileOpening(id, viewer.key)).toBe(false)
    expect(store.getState().openFiles).toHaveLength(0)
    usePluginFileViewerStore.setState({ status: 'loading', viewers: [] })
    const next = store.getState().openFile(input)
    store.setState({ worktreesByRepo: {}, repos: [] })
    expect(store.getState().resolveFileOpening(next, 'core')).toBe(false)
    expect(store.getState().openFiles[0]?.mode).toBe('file-opening')
  })
  it('resolves only current approved identities, including after metadata withdrawal', () => {
    const store = makeStore()
    const id = store.getState().openFile(input)
    usePluginFileViewerStore.setState({ status: 'ready', viewers: [viewer] })
    expect(store.getState().resolveFileOpening(id, 'viewer:another.viewer/sample')).toBe(false)
    usePluginFileViewerStore.setState({ viewers: [] })
    expect(store.getState().resolveFileOpening(id, viewer.key)).toBe(false)
    expect(store.getState().resolveFileOpening(id, 'core')).toBe(true)
    expect(store.getState().openFiles[0]).toMatchObject({ mode: 'edit', readOnly: undefined })
  })
  it('opens a single approved viewer directly while explicit core and View Log remain core', () => {
    const store = makeStore()
    usePluginFileViewerStore.setState({ status: 'ready', viewers: [viewer] })
    const pluginId = store.getState().openFile(input)
    expect(store.getState().openFiles.find((file) => file.id === pluginId)?.mode).toBe(
      'plugin-viewer'
    )
    const coreId = store.getState().openFile(input, { fileViewer: 'core' })
    expect(store.getState().openFiles.find((file) => file.id === coreId)?.mode).toBe('edit')
    const logId = store
      .getState()
      .openFile({ ...input, filePath: '/repo/log.sample', readOnly: true, liveTail: true })
    expect(store.getState().openFiles.find((file) => file.id === logId)).toMatchObject({
      mode: 'edit',
      readOnly: true,
      liveTail: true
    })
  })
  it('restores a pending tab with a qualified identity and no dirty draft or parser authority', () => {
    const store = makeStore()
    store.getState().hydrateEditorSession({
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: {
        'wt-1': [
          {
            filePath: input.filePath,
            relativePath: input.relativePath,
            worktreeId: input.worktreeId,
            language: input.language,
            fileOpening: { readOnly: false },
            readOnly: false,
            dirtyDraftContent: 'forbidden'
          }
        ]
      }
    })
    const file = store.getState().openFiles[0]!
    expect(file).toMatchObject({ mode: 'file-opening', readOnly: true, isDirty: false })
    expect(file.id).toMatch(/^file-opening:/)
    expect(store.getState().editorDrafts[file.id]).toBeUndefined()
    expect(store.getState().resolveFileOpening(file.id, 'core')).toBe(true)
    expect(store.getState().openFiles[0]?.readOnly).toBeUndefined()
  })
})
