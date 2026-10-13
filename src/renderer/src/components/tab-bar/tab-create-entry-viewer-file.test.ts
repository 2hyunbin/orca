import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { usePluginFileViewerStore } from '@/store/plugin-file-viewers'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { buildEditorSessionData } from '@/lib/workspace-session'
import { persistedOpenFileSchema } from '../../../../shared/workspace-session-editor-schema'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree, makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { classifyTabEntryQuery } from './tab-create-entry-classifier'
import {
  absoluteTabEntryViewerOwner,
  openAbsoluteTabEntryViewerFile
} from './tab-create-entry-viewer-file'

const initial = useAppStore.getInitialState()
const openFile = vi.fn()
const worktreeId = 'repo::/remote/repo'
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
function seed(path = '/remote/repo'): void {
  useAppStore.setState(
    {
      ...initial,
      repos: [
        {
          id: 'repo',
          path,
          displayName: 'Repo',
          badgeColor: '',
          addedAt: 0,
          executionHostId: 'runtime:hub'
        }
      ],
      worktreesByRepo: {
        repo: [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo',
            path,
            hostId: 'runtime:hub',
            runtimeOwnerEnvironmentId: 'hub'
          })
        ]
      },
      runtimeEnvironmentCatalogHydrated: true,
      runtimeEnvironments: [
        {
          id: 'hub',
          name: 'Host',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null,
          runtimeId: 'runtime-hub',
          preferredEndpointId: 'ws-hub',
          endpoints: [
            {
              id: 'ws-hub',
              label: 'Host',
              kind: 'websocket',
              endpoint: 'ws://127.0.0.1:1'
            }
          ]
        }
      ],
      settings: createGlobalSettingsFixture(),
      openFile
    },
    true
  )
  replaceRuntimeEnvironmentRevisions([{ id: 'hub', createdAt: 1 }])
}
function open(path: string): void {
  const expectedOwner = absoluteTabEntryViewerOwner(useAppStore.getState(), worktreeId)
  openAbsoluteTabEntryViewerFile({
    filePath: path,
    worktreeId,
    groupId: 'right',
    expectedOwner: expectedOwner ?? undefined
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  seed()
  usePluginFileViewerStore.setState({ status: 'ready', viewers: [viewer], syntaxPacks: [] })
})
afterEach(() => {
  useAppStore.setState(initial, true)
  usePluginFileViewerStore.setState({ status: 'idle', viewers: [], syntaxPacks: [] })
  replaceRuntimeEnvironmentRevisions([])
})
describe('user-named remote viewer files', () => {
  it('accepts a positively pinned non-Git folder without requiring a Git worktree projection', () => {
    const folder = makeFolderWorkspace({ executionHostId: 'runtime:hub' })
    useAppStore.setState({ folderWorkspaces: [folder] })
    const id = folderWorkspaceKey(folder.id)
    const expectedOwner = absoluteTabEntryViewerOwner(useAppStore.getState(), id) ?? undefined
    expect(expectedOwner).toBeDefined()
    openAbsoluteTabEntryViewerFile({
      filePath: '/outside/report.sample',
      worktreeId: id,
      groupId: 'right',
      expectedOwner
    })
    expect(openFile.mock.calls[0][0]).toMatchObject({
      worktreeId: id,
      mode: 'plugin-viewer',
      runtimeEnvironmentId: 'hub',
      pluginViewerUserSelectedFile: true
    })
    useAppStore.setState({ folderWorkspaces: [] })
    expect(() =>
      openAbsoluteTabEntryViewerFile({
        filePath: '/outside/report.sample',
        worktreeId: id,
        groupId: 'right',
        expectedOwner
      })
    ).toThrow()
  })
  it('does not infer a folder selection owner from the globally active runtime', () => {
    const folder = makeFolderWorkspace()
    useAppStore.setState({
      folderWorkspaces: [folder],
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'hub' })
    })
    expect(
      absoluteTabEntryViewerOwner(useAppStore.getState(), folderWorkspaceKey(folder.id))
    ).toBeNull()
  })
  it('opens a host-owned read-only viewer in the requested pane without local stat', () => {
    open('/outside/report.sample')
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/outside/report.sample',
        relativePath: '/outside/report.sample',
        mode: 'plugin-viewer',
        runtimeEnvironmentId: 'hub',
        readOnly: true,
        pluginViewerUserSelectedFile: true,
        pluginViewer: { key: viewer.key, sourceView: { readOnly: true } }
      }),
      { preview: false, targetGroupId: 'right' }
    )
  })
  it('offers a chooser rather than an editable fallback for unmatched files or core defaults', () => {
    open('/outside/unknown.format')
    expect(openFile.mock.calls[0][0]).toMatchObject({
      mode: 'file-opening',
      readOnly: true,
      fileOpeningChoicePending: true
    })
    useAppStore.setState({
      settings: createGlobalSettingsFixture({
        pluginViewerAssociations: [
          { selector: { kind: 'extension', value: '.sample' }, viewerKey: 'core' }
        ]
      })
    })
    open('/outside/report.sample')
    expect(openFile.mock.calls[1][0]).toMatchObject({
      mode: 'file-opening',
      readOnly: true,
      pluginViewerUserSelectedFile: true
    })
  })
  it('keeps the waiting surface until viewer metadata arrives', () => {
    usePluginFileViewerStore.setState({ status: 'loading', viewers: [] })
    open('/outside/report.sample')
    expect(openFile.mock.calls[0][0]).toMatchObject({
      mode: 'file-opening',
      readOnly: true,
      fileOpeningChoicePending: false
    })
  })
  it('validates the filesystem host syntax rather than the desktop platform', () => {
    expect(() => open('C:\\outside\\report.sample')).toThrow('for this host')
    seed('C:\\repo')
    open('C:\\outside\\report.sample')
    expect(openFile.mock.calls[0][0].filePath).toBe('C:/outside/report.sample')
    expect(() => open('/outside/report.sample')).toThrow('for this host')
  })
  it.each(['/outside/', '/outside/file\n.sample', '~/report.sample'])(
    'rejects invalid named path %s before opening a tab',
    (path) => {
      expect(() => open(path)).toThrow()
      expect(openFile).not.toHaveBeenCalled()
    }
  )
  it('refuses a pairing replacement between presentation and action', () => {
    const expectedOwner =
      absoluteTabEntryViewerOwner(useAppStore.getState(), worktreeId) ?? undefined
    replaceRuntimeEnvironmentRevisions([{ id: 'hub', createdAt: 2 }])
    expect(() =>
      openAbsoluteTabEntryViewerFile({
        filePath: '/outside/report.sample',
        worktreeId,
        groupId: 'right',
        expectedOwner
      })
    ).toThrow('connection settles')
    expect(openFile).not.toHaveBeenCalled()
  })
  it('refuses a missing or local owner and missing presentation identity', () => {
    expect(absoluteTabEntryViewerOwner(useAppStore.getState(), 'missing')).toBeNull()
    expect(() =>
      openAbsoluteTabEntryViewerFile({
        filePath: '/outside/report.sample',
        worktreeId,
        groupId: 'right'
      })
    ).toThrow()
    useAppStore.setState({
      worktreesByRepo: {
        repo: [
          makeWorktree({ id: worktreeId, repoId: 'repo', path: '/remote/repo', hostId: 'local' })
        ]
      },
      repos: [{ id: 'repo', path: '/remote/repo', displayName: 'Repo', badgeColor: '', addedAt: 0 }]
    })
    expect(absoluteTabEntryViewerOwner(useAppStore.getState(), worktreeId)).toBeNull()
    expect(openFile).not.toHaveBeenCalled()
  })
  it('carries viewer-only owner identity through classification without permitting local editing', () => {
    const owner = absoluteTabEntryViewerOwner(useAppStore.getState(), worktreeId) ?? undefined
    expect(
      classifyTabEntryQuery(
        '/outside/report.sample',
        { files: [], loading: false, loadError: null },
        {
          allowAbsolutePaths: false,
          allowAbsoluteViewerPaths: true,
          absoluteViewerOwner: owner,
          localPlatform: 'posix'
        }
      )
    ).toEqual({
      kind: 'absolute-file',
      filePath: '/outside/report.sample',
      viewerOnly: true,
      viewerOwner: owner
    })
  })
  it('persists selected intent without persisting grant or socket authority', () => {
    open('/outside/report.sample')
    const file: OpenFile = { ...openFile.mock.calls[0][0], id: 'tab', isDirty: false }
    const result = buildEditorSessionData([file], {}, {}, {}, {})
    const saved = result.openFilesByWorktree?.[worktreeId]?.[0]
    expect(saved).toMatchObject({ pluginViewerUserSelectedFile: true, readOnly: true })
    expect(saved).not.toHaveProperty('operationProvenance')
    expect(saved).not.toHaveProperty('selectionGrantId')
    expect(persistedOpenFileSchema.parse(saved)).toMatchObject({
      pluginViewerUserSelectedFile: true
    })
    expect(
      persistedOpenFileSchema.safeParse({ ...saved, pluginViewerUserSelectedFile: false }).success
    ).toBe(false)
  })
})
