import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'
import { captureEditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import { usePluginFileViewerStore } from '../plugin-file-viewers'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { AppState } from '../types'
import type { StoreApi } from 'zustand/vanilla'
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
  runtimeEnvironmentId: null,
  language: 'plaintext',
  mode: 'plugin-viewer',
  pluginViewer: {
    key: viewer.key,
    sourceView: { readOnly: true },
    viewport: { kind: 'text', startLine: 64, lineCount: 64 }
  }
}

function publishConnection(store: StoreApi<AppState>, generation: number): void {
  store.setState({
    worktreesByRepo: {
      'repo-1': [{ ...store.getState().worktreesByRepo['repo-1']![0]!, hostId: 'ssh:target' }]
    },
    sshConnectionStates: new Map([
      [
        'target',
        {
          targetId: 'target',
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          connectionGeneration: generation
        }
      ]
    ])
  })
}
function capture(store: StoreApi<AppState>) {
  return captureEditorFileOperationProvenance(store.getState(), 'wt-1', null, true)
}
afterEach(() => {
  vi.unstubAllGlobals()
  usePluginFileViewerStore.setState({ status: 'idle', viewers: [], syntaxPacks: [] })
})

describe('verified reopening of a file viewer', () => {
  it('replaces expired connection authority and remounts the existing parser while keeping its viewport', () => {
    const store = createEditorTabsStore()
    publishConnection(store, 1)
    const original = capture(store)
    const id = store.getState().openFile({ ...input, operationProvenance: original })
    publishConnection(store, 2)
    const current = capture(store)
    const reopened = store.getState().openFile({
      ...input,
      operationProvenance: current,
      pluginViewer: { key: viewer.key, sourceView: { readOnly: false } }
    })
    expect(reopened).toBe(id)
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0]).toMatchObject({
      operationProvenance: current,
      fileContentReloadNonce: 1,
      readOnly: true,
      pluginViewer: { ...input.pluginViewer, sourceView: { readOnly: false } }
    })
    store.getState().openFile({ ...input, operationProvenance: capture(store) })
    expect(store.getState().openFiles[0]?.fileContentReloadNonce).toBe(1)
  })
  it('does not refresh or restart authority from a stale incoming reopen', () => {
    const store = createEditorTabsStore()
    publishConnection(store, 1)
    const expired = capture(store)
    const id = store.getState().openFile({ ...input, operationProvenance: expired })
    publishConnection(store, 2)
    store.getState().openFile({ ...input, operationProvenance: expired })
    expect(store.getState().openFiles[0]).toMatchObject({ id, operationProvenance: expired })
    expect(store.getState().openFiles[0]?.fileContentReloadNonce).toBeUndefined()
  })
  it('merges a newly resolved waiting tab into an expired viewer with fresh authority', () => {
    vi.stubGlobal('window', { api: { plugins: { listFileViewers: vi.fn() } } })
    const store = createEditorTabsStore()
    store.setState({ settings: createGlobalSettingsFixture() })
    publishConnection(store, 1)
    const id = store.getState().openFile({ ...input, operationProvenance: capture(store) })
    publishConnection(store, 2)
    usePluginFileViewerStore.setState({ status: 'loading', viewers: [], syntaxPacks: [] })
    const pending = store.getState().openFile({ ...input, mode: 'edit', pluginViewer: undefined })
    const current = capture(store)
    expect(pending).not.toBe(id)
    usePluginFileViewerStore.setState({ status: 'ready', viewers: [viewer] })
    expect(store.getState().resolveFileOpening(pending, viewer.key)).toBe(true)
    expect(store.getState().openFiles).toHaveLength(1)
    expect(store.getState().openFiles[0]).toMatchObject({
      id,
      operationProvenance: current,
      fileContentReloadNonce: 1,
      pluginViewer: { ...input.pluginViewer, sourceView: { readOnly: false } }
    })
    expect(store.getState().unifiedTabsByWorktree['wt-1']).toHaveLength(1)
    expect(store.getState().unifiedTabsByWorktree['wt-1']![0]?.entityId).toBe(id)
  })
  it('adds verified authority once when a restored viewer has no ephemeral provenance', () => {
    const store = createEditorTabsStore()
    const id = store.getState().openFile(input)
    const current = capture(store)
    store.getState().openFile({ ...input, operationProvenance: current })
    expect(store.getState().openFiles[0]).toMatchObject({
      id,
      operationProvenance: current,
      fileContentReloadNonce: 1
    })
  })
  it('replaces a session whose owner disappeared and returned with the same generation', () => {
    const store = createEditorTabsStore()
    const provenance = capture(store)
    const id = store.getState().openFile({ ...input, operationProvenance: provenance })
    store.setState((state) => ({
      openFiles: state.openFiles.map((file) => ({ ...file, pluginViewerOwnerExpired: true }))
    }))
    store.getState().openFile({ ...input, operationProvenance: capture(store) })
    expect(store.getState().openFiles[0]).toMatchObject({
      id,
      operationProvenance: provenance,
      fileContentReloadNonce: 1,
      pluginViewerOwnerExpired: undefined
    })
  })
})
