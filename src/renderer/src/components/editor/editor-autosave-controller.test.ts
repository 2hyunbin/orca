import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { createEditorSlice, type OpenFile } from '@/store/slices/editor'
import type { AppState } from '@/store'
import { ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT } from '../../../../shared/editor-save-events'
import { requestEditorHotExitBackup } from '../../../../shared/editor-hot-exit-request'
import { isRestartCancelledByUser } from '../../../../shared/app-restart-cancellation'
import {
  answerRestartUnsavedChangesRequest,
  getRestartUnsavedChangesFilePaths,
  subscribeRestartUnsavedChangesRequest
} from './restart-unsaved-changes-dialog'
import { requestEditorFileSave, requestEditorSaveQuiesce } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { registerEditorBufferOwner } from './editor-buffer-owners'
import { __clearSelfWriteRegistryForTests, hasRecentSelfWrite } from './editor-self-write-registry'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

const mocks = vi.hoisted(() => ({
  getConnectionIdForFile: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))

type WindowStub = {
  addEventListener: Window['addEventListener']
  removeEventListener: Window['removeEventListener']
  dispatchEvent: Window['dispatchEvent']
  setTimeout: Window['setTimeout']
  clearTimeout: Window['clearTimeout']
  api: {
    fs: {
      writeFile: ReturnType<typeof vi.fn>
    }
    runtimeEnvironments?: {
      call: ReturnType<typeof vi.fn>
    }
  }
}

function createEditorStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    activeWorktreeId: 'wt-1',
    settings: {
      editorAutoSave: true,
      editorAutoSaveDelayMs: 1000
    },
    repos: [],
    worktreesByRepo: {
      'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }]
    },
    detectedWorktreesByRepo: {},
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set(),
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
  })) as unknown as StoreApi<AppState>
}

async function requestDirtyFileSave(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let claimed = false
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT, {
        detail: {
          claim: () => {
            claimed = true
          },
          resolve,
          reject: (message: string) => reject(new Error(message))
        }
      })
    )

    if (!claimed) {
      resolve()
    }
  })
}

// Why: the preload world hands the page a structured clone of an event's detail, and back.
class IsolatedWorldEventTarget extends EventTarget {
  override dispatchEvent(event: Event): boolean {
    if (!('detail' in event)) {
      return super.dispatchEvent(event)
    }
    return super.dispatchEvent(
      new CustomEvent(event.type, { detail: structuredClone(event.detail) })
    )
  }
}

function stubIsolatedWorldWindow(writeFile: ReturnType<typeof vi.fn>): EventTarget {
  const eventTarget = new IsolatedWorldEventTarget()
  vi.stubGlobal('window', {
    addEventListener: eventTarget.addEventListener.bind(eventTarget),
    removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
    dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    api: { fs: { writeFile } }
  } satisfies WindowStub)
  return eventTarget
}

function openDirtyFile(
  store: StoreApi<AppState>,
  relativePath: string,
  draft: string,
  diffSource?: 'unstaged' | 'staged'
): void {
  const filePath = `/repo/${relativePath}`
  const surface: Pick<OpenFile, 'mode' | 'diffSource'> = diffSource
    ? { mode: 'diff', diffSource }
    : { mode: 'edit' }
  store.getState().openFile({
    filePath,
    relativePath,
    worktreeId: 'wt-1',
    language: 'typescript',
    ...surface
  })
  store.getState().setEditorDraft(filePath, draft)
  store.getState().markFileDirty(filePath, true)
}

function makeSessionReadyState(): Partial<AppState> {
  return {
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    activeRepoId: 'repo-1',
    activeTabId: 'tab-1',
    tabsByWorktree: {
      'wt-1': [{ id: 'tab-1', title: 'shell', ptyId: null, worktreeId: 'wt-1' } as never]
    },
    ptyIdsByTabId: { 'tab-1': [] },
    terminalLayoutsByTabId: {
      'tab-1': { root: null, activeLeafId: null, expandedLeafId: null }
    },
    activeTabIdByWorktree: { 'wt-1': 'tab-1' },
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: {},
    browserUrlHistory: [],
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    sshConnectionStates: new Map(),
    repos: [],
    worktreesByRepo: {},
    lastKnownRelayPtyIdByTabId: {},
    lastVisitedAtByWorktreeId: {},
    defaultTerminalTabsAppliedByWorktreeId: {}
  } as Partial<AppState>
}

describe('attachEditorAutosaveController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getConnectionIdForFile.mockReset()
    mocks.getConnectionIdForFile.mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __clearSelfWriteRegistryForTests()
  })

  it('saves dirty files even when the visible EditorPanel is not mounted', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const eventTarget = new EventTarget()
    vi.stubGlobal('window', {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      api: {
        fs: {
          writeFile
        }
      }
    } satisfies WindowStub)

    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setEditorDraft('/repo/file.ts', 'edited')
    store.getState().markFileDirty('/repo/file.ts', true)

    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestDirtyFileSave()

      expect(writeFile).toHaveBeenCalledWith({
        filePath: '/repo/file.ts',
        content: 'edited',
        connectionId: undefined,
        expectedExecutionHostId: 'local'
      })
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
      expect(store.getState().editorDrafts).toEqual({})
    } finally {
      cleanup()
    }
  })

  it('saves folder workspace files through the path-specific SSH connection', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const eventTarget = new EventTarget()
    vi.stubGlobal('window', {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      api: {
        fs: {
          writeFile
        }
      }
    } satisfies WindowStub)

    const store = createEditorStore()
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    store.setState({
      worktreesByRepo: {
        'folder-workspace-1': [
          {
            id: workspaceKey,
            repoId: 'folder-workspace-1',
            path: '/home/neil/platform',
            hostId: 'ssh:ssh-1'
          }
        ] as never
      },
      sshConnectionStates: new Map([
        [
          'ssh-1',
          {
            targetId: 'ssh-1',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            connectionGeneration: 4
          }
        ]
      ])
    })
    store.getState().openFile({
      filePath: '/home/neil/platform/api/src/file.ts',
      relativePath: 'api/src/file.ts',
      worktreeId: workspaceKey,
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setEditorDraft('/home/neil/platform/api/src/file.ts', 'edited')
    store.getState().markFileDirty('/home/neil/platform/api/src/file.ts', true)

    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestDirtyFileSave()

      expect(writeFile).toHaveBeenCalledWith({
        filePath: '/home/neil/platform/api/src/file.ts',
        content: 'edited',
        connectionId: 'ssh-1',
        expectedExecutionHostId: 'ssh:ssh-1',
        expectedSshTargetId: 'ssh-1',
        expectedSshConnectionGeneration: 4
      })
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('saves runtime-owned folder workspace files through the folder root', async () => {
    clearRuntimeCompatibilityCacheForTests()
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const runtimeCall = vi.fn().mockResolvedValue({
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-env-1' }
    })
    const runtimeTransportCall = vi.fn((args: RuntimeEnvironmentCallRequest) => {
      return (
        createCompatibleRuntimeStatusResponseIfNeeded(args, 'runtime-env-1') ?? runtimeCall(args)
      )
    })
    const eventTarget = new EventTarget()
    vi.stubGlobal('window', {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      api: {
        fs: { writeFile },
        runtimeEnvironments: { call: runtimeTransportCall }
      }
    } satisfies WindowStub)

    const store = createEditorStore()
    const workspaceId = 'folder-workspace-runtime'
    const workspaceKey = folderWorkspaceKey(workspaceId)
    store.setState({
      settings: {
        editorAutoSave: true,
        editorAutoSaveDelayMs: 1000,
        activeRuntimeEnvironmentId: 'env-2'
      } as never,
      worktreesByRepo: {},
      folderWorkspaces: [
        {
          id: workspaceId,
          projectGroupId: 'group-runtime',
          folderPath: '/runtime/folder',
          connectionId: null
        } as never
      ],
      projectGroups: [
        {
          id: 'group-runtime',
          connectionId: null,
          executionHostId: 'runtime:env-1'
        } as never
      ]
    })
    store.getState().openFile({
      filePath: '/runtime/folder/src/file.ts',
      relativePath: 'src/file.ts',
      worktreeId: workspaceKey,
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setEditorDraft('/runtime/folder/src/file.ts', 'edited')
    store.getState().markFileDirty('/runtime/folder/src/file.ts', true)

    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestDirtyFileSave()

      expect(runtimeCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.write',
        expectedEnvironmentPairingRevision: undefined,
        params: {
          worktree: `id:${workspaceKey}`,
          relativePath: 'src/file.ts',
          content: 'edited',
          expectedExecutionHostId: 'local'
        },
        timeoutMs: 15_000
      })
      expect(writeFile).not.toHaveBeenCalled()
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('saves remote files through the owning runtime environment', async () => {
    clearRuntimeCompatibilityCacheForTests()
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const runtimeCall = vi.fn().mockResolvedValue({
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-env-1' }
    })
    const runtimeTransportCall = vi.fn((args: RuntimeEnvironmentCallRequest) => {
      return (
        createCompatibleRuntimeStatusResponseIfNeeded(args, 'runtime-env-1') ?? runtimeCall(args)
      )
    })
    const eventTarget = new EventTarget()
    vi.stubGlobal('window', {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      api: {
        fs: { writeFile },
        runtimeEnvironments: { call: runtimeTransportCall }
      }
    } satisfies WindowStub)

    const store = createEditorStore()
    store.setState({
      settings: {
        editorAutoSave: true,
        editorAutoSaveDelayMs: 1000,
        activeRuntimeEnvironmentId: 'env-2'
      } as never,
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1', path: '/remote/repo' }] as never
      }
    })
    store.getState().openFile({
      filePath: '/remote/repo/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: 'env-1',
      language: 'typescript',
      mode: 'edit'
    })
    store.getState().setEditorDraft('/remote/repo/file.ts', 'edited')
    store.getState().markFileDirty('/remote/repo/file.ts', true)

    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestDirtyFileSave()

      expect(runtimeCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.write',
        expectedEnvironmentPairingRevision: undefined,
        params: {
          worktree: 'id:wt-1',
          relativePath: 'file.ts',
          content: 'edited',
          expectedExecutionHostId: 'local'
        },
        timeoutMs: 15_000
      })
      expect(writeFile).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })

  it('flushes mounted rich-editor changes before restart-driven dirty-file saves', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const eventTarget = new EventTarget()
    vi.stubGlobal('window', {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      api: {
        fs: {
          writeFile
        }
      }
    } satisfies WindowStub)

    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/file.md',
      relativePath: 'file.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().markFileDirty('/repo/file.md', true)

    const unregisterFlush = registerEditorBufferOwner('/repo/file.md', {
      flush: () => store.getState().setEditorDraft('/repo/file.md', 'pending rich edit')
    })
    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestDirtyFileSave()

      expect(writeFile).toHaveBeenCalledWith({
        filePath: '/repo/file.md',
        content: 'pending rich edit',
        connectionId: undefined,
        expectedExecutionHostId: 'local'
      })
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
      expect(store.getState().editorDrafts).toEqual({})
    } finally {
      cleanup()
      unregisterFlush()
    }
  })

  it('quiesces pending autosave timers without needing the editor UI tree', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const eventTarget = new EventTarget()
    vi.stubGlobal('window', {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      api: {
        fs: {
          writeFile
        }
      }
    } satisfies WindowStub)

    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })

    const cleanup = attachEditorAutosaveController(store)
    try {
      store.getState().setEditorDraft('/repo/file.ts', 'edited')
      store.getState().markFileDirty('/repo/file.ts', true)

      await requestEditorSaveQuiesce({ fileId: '/repo/file.ts' })
      await vi.advanceTimersByTimeAsync(1000)

      expect(writeFile).not.toHaveBeenCalled()
      expect(store.getState().openFiles[0]?.isDirty).toBe(true)
      expect(store.getState().editorDrafts['/repo/file.ts']).toBe('edited')
    } finally {
      cleanup()
    }
  })

  it('drops an autosave already queued when owner migration starts', async () => {
    let releaseFirstWrite!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    const writeFile = vi.fn().mockReturnValueOnce(firstWrite).mockResolvedValue(undefined)
    const eventTarget = new EventTarget()
    vi.stubGlobal('window', {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      api: { fs: { writeFile } }
    } satisfies WindowStub)

    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
    const cleanup = attachEditorAutosaveController(store)
    try {
      store.getState().setEditorDraft('/repo/file.ts', 'first autosave')
      store.getState().markFileDirty('/repo/file.ts', true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(writeFile).toHaveBeenCalledTimes(1)

      store.getState().setEditorDraft('/repo/file.ts', 'queued autosave')
      store.getState().markFileDirty('/repo/file.ts', true)
      await vi.advanceTimersByTimeAsync(1000)
      store.getState().setRestoredEditorOwnerMigrationPending('/repo/file.ts', true)
      releaseFirstWrite()
      for (let index = 0; index < 6; index += 1) {
        await Promise.resolve()
      }

      expect(writeFile).toHaveBeenCalledTimes(1)
      expect(store.getState().editorDrafts['/repo/file.ts']).toBe('queued autosave')
    } finally {
      cleanup()
    }
  })

  it('saves what autosave can before a restart, then asks once about what the restart cannot keep', async () => {
    // Why: b.ts stands for a save that never finishes, such as one to an unreachable SSH host.
    const writeFile = vi
      .fn()
      .mockImplementation(({ filePath }: { filePath: string }) =>
        filePath === '/repo/b.ts' ? new Promise<void>(() => undefined) : Promise.resolve()
      )
    const eventTarget = stubIsolatedWorldWindow(writeFile)
    const store = createEditorStore()
    // Why: keep the worktree so the saves resolve a write target instead of failing fast.
    store.setState({
      ...makeSessionReadyState(),
      worktreesByRepo: store.getState().worktreesByRepo
    })
    openDirtyFile(store, 'a.ts', 'saved before restart')
    openDirtyFile(store, 'b.ts', 'stalled save', 'unstaged')
    const unsubscribeDialog = subscribeRestartUnsavedChangesRequest(() => undefined)
    const cleanup = attachEditorAutosaveController(store)
    try {
      const outcome = requestEditorHotExitBackup(eventTarget, true).then(
        () => 'restarted',
        (error: unknown) => error
      )
      await vi.advanceTimersByTimeAsync(4_999)
      expect(getRestartUnsavedChangesFilePaths()).toBeNull()
      await vi.advanceTimersByTimeAsync(1)

      expect(store.getState().openFiles.find((file) => file.relativePath === 'a.ts')?.isDirty).toBe(
        false
      )
      expect(getRestartUnsavedChangesFilePaths()).toEqual(['b.ts'])
      answerRestartUnsavedChangesRequest('cancel')

      expect(isRestartCancelledByUser(await outcome)).toBe(true)
      expect(store.getState().editorDrafts['/repo/b.ts']).toBe('stalled save')
    } finally {
      cleanup()
      unsubscribeDialog()
    }
  })

  it('asks again when unsaved files join while the dialog is open; automatic restarts never ask', async () => {
    const eventTarget = stubIsolatedWorldWindow(vi.fn().mockResolvedValue(undefined))
    const store = createEditorStore()
    store.setState(makeSessionReadyState())
    openDirtyFile(store, 'c.ts', 'staged edit', 'staged')
    const unsubscribeDialog = subscribeRestartUnsavedChangesRequest(() => undefined)
    const cleanup = attachEditorAutosaveController(store)
    const unregisterNotebook = registerEditorBufferOwner('/repo/d.ipynb', {
      flush: vi.fn(),
      canBackUp: () => false
    })
    try {
      await expect(requestEditorHotExitBackup(eventTarget, false)).rejects.toThrow(
        'Some unsaved editor changes cannot be backed up before restart.'
      )
      expect(getRestartUnsavedChangesFilePaths()).toBeNull()

      const outcome = requestEditorHotExitBackup(eventTarget, true).then(
        () => 'restarted',
        (error: unknown) => error
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(getRestartUnsavedChangesFilePaths()).toEqual(['c.ts'])
      openDirtyFile(store, 'd.ipynb', 'late edit')
      answerRestartUnsavedChangesRequest('restart-anyway')
      await vi.advanceTimersByTimeAsync(0)

      expect(getRestartUnsavedChangesFilePaths()).toEqual(['c.ts', 'd.ipynb'])
      answerRestartUnsavedChangesRequest('restart-anyway')
      expect(await outcome).toBe('restarted')
    } finally {
      cleanup()
      unsubscribeDialog()
      unregisterNotebook()
    }
  })

  it('skips the open-file scan for unrelated store mutations', () => {
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const eventTarget = new EventTarget()
    vi.stubGlobal('window', {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      api: {
        fs: {
          writeFile
        }
      }
    } satisfies WindowStub)

    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/file.ts',
      relativePath: 'file.ts',
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })

    const openFiles = store.getState().openFiles
    const originalMap = openFiles.map.bind(openFiles)
    let mapCalls = 0
    Object.defineProperty(openFiles, 'map', {
      configurable: true,
      value: (...args: Parameters<typeof openFiles.map>) => {
        mapCalls += 1
        return originalMap(...args)
      }
    })

    const cleanup = attachEditorAutosaveController(store)
    try {
      expect(mapCalls).toBe(1)
      mapCalls = 0

      store.setState({ activeWorktreeId: 'wt-2' } as Partial<AppState>)
      expect(mapCalls).toBe(0)

      store.getState().setEditorDraft('/repo/file.ts', 'edited')
      expect(mapCalls).toBe(1)
    } finally {
      cleanup()
    }
  })

  it('flushes mounted rich-editor changes before quiescing or direct saves', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const eventTarget = new EventTarget()
    vi.stubGlobal('window', {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      api: {
        fs: {
          writeFile
        }
      }
    } satisfies WindowStub)

    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/file.md',
      relativePath: 'file.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().markFileDirty('/repo/file.md', true)

    const drafts = ['after quiesce', 'after save']
    const unregisterFlush = registerEditorBufferOwner('/repo/file.md', {
      flush: () => {
        const nextDraft = drafts.shift()
        if (nextDraft) {
          store.getState().setEditorDraft('/repo/file.md', nextDraft)
        }
      }
    })
    const cleanup = attachEditorAutosaveController(store)
    try {
      await requestEditorSaveQuiesce({ fileId: '/repo/file.md' })
      expect(store.getState().editorDrafts['/repo/file.md']).toBe('after quiesce')
      expect(writeFile).not.toHaveBeenCalled()

      await requestEditorFileSave({ fileId: '/repo/file.md' })
      expect(writeFile).toHaveBeenCalledWith({
        filePath: '/repo/file.md',
        content: 'after save',
        connectionId: undefined,
        expectedExecutionHostId: 'local'
      })
      expect(store.getState().openFiles[0]?.isDirty).toBe(false)
    } finally {
      cleanup()
      unregisterFlush()
    }
  })

  it('clears the self-write stamp when a save fails before touching disk', async () => {
    const writeFile = vi.fn().mockRejectedValue(new Error('disk full'))
    const eventTarget = new EventTarget()
    vi.stubGlobal('window', {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      api: {
        fs: {
          writeFile
        }
      }
    } satisfies WindowStub)

    const store = createEditorStore()
    store.getState().openFile({
      filePath: '/repo/file.md',
      relativePath: 'file.md',
      worktreeId: 'wt-1',
      language: 'markdown',
      mode: 'edit'
    })
    store.getState().setEditorDraft('/repo/file.md', 'edited')
    store.getState().markFileDirty('/repo/file.md', true)

    const cleanup = attachEditorAutosaveController(store)
    try {
      await expect(requestEditorFileSave({ fileId: '/repo/file.md' })).rejects.toThrow('disk full')
      expect(hasRecentSelfWrite('/repo/file.md')).toBe(false)
    } finally {
      cleanup()
    }
  })
})
