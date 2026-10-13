import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openPluginFileChoice } from './open-plugin-file-choice'
import { usePluginFileViewerStore } from '@/store/plugin-file-viewers'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { OpenFile } from '@/store/slices/editor'

const { store, assertOwner } = vi.hoisted(() => ({
  store: { getState: vi.fn() },
  assertOwner: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: store }))
vi.mock('@/lib/editor-file-operation-owner', () => ({
  captureEditorFileOperationProvenance: () => ({ captured: true }),
  assertEditorFileOperationCurrent: assertOwner
}))
const file: OpenFile = {
  id: 'pending',
  filePath: '/folder/file.sample',
  relativePath: 'file.sample',
  worktreeId: 'folder',
  language: 'plaintext',
  mode: 'file-opening',
  readOnly: true,
  isDirty: false,
  fileOpening: { readOnly: false }
}
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
const settings = createGlobalSettingsFixture()
const openFile = vi.fn()
const resolve = vi.fn(() => true)
const save = vi.fn(async () => {})
let openFiles = [file]
beforeEach(() => {
  vi.clearAllMocks()
  openFiles = [file]
  assertOwner.mockReturnValue({ runtimeEnvironmentId: null })
  usePluginFileViewerStore.setState({ status: 'ready', viewers: [viewer], syntaxPacks: [] })
  store.getState.mockImplementation(() => ({
    settings,
    openFiles,
    openFile,
    resolveFileOpening: resolve,
    updateSettingsOrThrow: save,
    unifiedTabsByWorktree: { folder: [] }
  }))
})

describe('deliberate viewer choice across asynchronous persistence', () => {
  it('never saves a core default or opens a core editor for a user-selected remote file', async () => {
    const selected: OpenFile = { ...file, pluginViewerUserSelectedFile: true }
    openFiles = [selected]
    await expect(
      openPluginFileChoice(selected, 'core', { kind: 'extension', value: '.sample' })
    ).rejects.toThrow()
    expect(save).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
  })
  it('refuses a withdrawn viewer before writing preferences or opening a tab', async () => {
    usePluginFileViewerStore.setState({ viewers: [] })
    await expect(
      openPluginFileChoice(file, viewer.key, { kind: 'extension', value: '.sample' })
    ).rejects.toThrow('viewer unavailable')
    expect(save).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })
  it('does not recreate a source closed while its default was being saved', async () => {
    save.mockImplementationOnce(async () => {
      openFiles = []
    })
    await expect(
      openPluginFileChoice(file, viewer.key, { kind: 'extension', value: '.sample' })
    ).rejects.toThrow('source closed')
    expect(save).toHaveBeenCalledOnce()
    expect(resolve).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
  })
  it('rechecks owner generation and approved metadata after persistence', async () => {
    save.mockImplementationOnce(async () => {
      assertOwner.mockImplementation(() => {
        throw new Error('owner changed')
      })
    })
    await expect(
      openPluginFileChoice(file, viewer.key, { kind: 'extension', value: '.sample' })
    ).rejects.toThrow('owner changed')
    expect(resolve).not.toHaveBeenCalled()
    assertOwner.mockReturnValue({ runtimeEnvironmentId: null })
    save.mockImplementationOnce(async () => {
      usePluginFileViewerStore.setState({ viewers: [] })
    })
    await expect(
      openPluginFileChoice(file, viewer.key, { kind: 'extension', value: '.sample' })
    ).rejects.toThrow('viewer unavailable')
    expect(resolve).not.toHaveBeenCalled()
  })
  it('does not fall back to the active pane after the source split closes', async () => {
    await expect(openPluginFileChoice(file, 'core', undefined, 'closed-pane-tab')).rejects.toThrow(
      'source pane closed'
    )
    expect(resolve).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
  })
  it('opens once without persisting a default and propagates a failed save without opening', async () => {
    await openPluginFileChoice(file, viewer.key)
    expect(resolve).toHaveBeenCalledWith(file.id, viewer.key)
    expect(save).not.toHaveBeenCalled()
    resolve.mockClear()
    save.mockRejectedValueOnce(new Error('settings unavailable'))
    await expect(
      openPluginFileChoice(file, viewer.key, { kind: 'extension', value: '.sample' })
    ).rejects.toThrow('settings unavailable')
    expect(resolve).not.toHaveBeenCalled()
  })
})
