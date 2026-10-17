// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { endLayoutFramePositions } from '@/runtime/layout-frame-position'
import { openWorkspaceLayoutFrameSync } from '@/runtime/workspace-layout-frame-sync'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { applyLayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-commands'
import type { LayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayoutModel } from '../../../../shared/workspace-layout/workspace-layout-model'
import { publishWorkspaceLayout } from '../../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutChangeFrame } from '../../../../shared/workspace-layout/workspace-layout-stream-frames'

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: true,
  callRuntimeRpc: vi.fn(
    async (_target: unknown, _method: string, _params: { command: LayoutCommand }) => ({
      ok: true,
      result: {}
    })
  )
}))

const stream = vi.hoisted(
  (): { onFrame: ((frame: WorkspaceLayoutChangeFrame) => void) | null } => ({ onFrame: null })
)

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/runtime/runtime-layout-client', () => ({
  subscribeRuntimeLayout: (
    _target: unknown,
    _params: unknown,
    onFrame: (frame: WorkspaceLayoutChangeFrame) => void
  ) => {
    stream.onFrame = onFrame
    return { close: () => {} }
  }
}))

const WT = 'repo-a::/repo-a'

let main: WorkspaceLayoutModel

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.callRuntimeRpc.mockClear()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial catalog with only the fields editor opens and frames read.
    {
      activeWorktreeId: WT,
      settings: { editorAutoSave: false },
      repos: [{ id: 'repo-a', path: '/repo-a', kind: 'git', executionHostId: 'local' }],
      worktreesByRepo: {
        'repo-a': [{ id: WT, repoId: 'repo-a', path: '/repo-a', hostId: 'local', branch: '' }]
      },
      detectedWorktreesByRepo: {},
      runtimeEnvironments: [],
      runtimeEnvironmentCatalogHydrated: true,
      removedRuntimeEnvironmentIds: new Set(),
      sshConnectionStates: new Map(),
      sshStateByEnvironment: new Map(),
      folderWorkspaces: [],
      projectGroups: [],
      gitStatusHugeByWorktree: {}
    } as unknown as Partial<AppState>
  )
  main = {
    hostId: LOCAL_EXECUTION_HOST_ID,
    workspaces: {},
    records: {},
    legacy: { terminalRowOwners: {} }
  }
})

afterEach(() => endLayoutFramePositions())

function applySent(): void {
  const commands = mocks.callRuntimeRpc.mock.calls.map((call) => call[2].command)
  mocks.layoutOwnerIsMain = true
  mocks.callRuntimeRpc.mockClear()
  let id = 0
  for (const command of commands) {
    const applied = applyLayoutCommand(main, command, {
      mintId: () => `main-${++id}`,
      mintLeafId: () => `leaf-${++id}`,
      now: () => 1
    })
    if (!applied.ok) {
      throw new Error(`${command.type} refused: ${applied.code}`)
    }
    main = applied.model
  }
}

async function showMainFrame(): Promise<void> {
  const sync = openWorkspaceLayoutFrameSync(useAppStore)
  stream.onFrame!({
    type: 'snapshot',
    workspaces: Object.entries(main.workspaces).map(([key, workspace]) => ({
      key,
      layout: publishWorkspaceLayout(workspace, LOCAL_EXECUTION_HOST_ID)
    }))
  })
  sync.start()
  await new Promise((resolve) => setTimeout(resolve, 0))
  sync.close()
}

function editorTabsAndFiles() {
  const state = useAppStore.getState()
  const fileIds = new Set(state.openFiles.map((file) => file.id))
  return (state.unifiedTabsByWorktree[WT] ?? []).map((tab) => ({
    kind: tab.contentType,
    entity: tab.entityId,
    hasFile: fileIds.has(tab.entityId)
  }))
}

describe('editor records under frames, layout-owner build', () => {
  it('keeps the file record of every editor tab main keeps', async () => {
    const state = useAppStore.getState()
    state.openFile(
      {
        filePath: '/repo-a/a.md',
        relativePath: 'a.md',
        worktreeId: WT,
        runtimeEnvironmentId: null,
        language: 'markdown',
        mode: 'edit'
      },
      { suppressActiveRuntimeFallback: true }
    )
    state.openDiff(WT, '/repo-a/b.ts', 'b.ts', 'typescript', false)
    state.openMarkdownPreview({
      filePath: '/repo-a/a.md',
      relativePath: 'a.md',
      worktreeId: WT,
      runtimeEnvironmentId: null,
      language: 'markdown'
    })
    applySent()
    const before = editorTabsAndFiles()
    expect(before.every((tab) => tab.hasFile)).toBe(true)

    await showMainFrame()

    expect(editorTabsAndFiles()).toEqual(before)
  })

  it('drops a diff record with the tab main closed, and keeps a record no tab shows', async () => {
    const state = useAppStore.getState()
    state.openDiff(WT, '/repo-a/b.ts', 'b.ts', 'typescript', false)
    applySent()
    const diffTab = useAppStore.getState().unifiedTabsByWorktree[WT]![0]!
    // A conflict review's selected file has no tab of its own.
    useAppStore.setState({
      openFiles: [
        ...useAppStore.getState().openFiles,
        {
          id: '/repo-a/c.ts',
          filePath: '/repo-a/c.ts',
          relativePath: 'c.ts',
          worktreeId: WT,
          language: 'typescript',
          isDirty: false,
          mode: 'edit'
        }
      ]
    })
    // Main closes the diff tab (another client's close).
    const closed = applyLayoutCommand(
      main,
      { type: 'closeTabs', workspace: WT, tabIds: [diffTab.id], force: true },
      { mintId: () => 'x', mintLeafId: () => 'y', now: () => 1 }
    )
    if (!closed.ok) {
      throw new Error(closed.code)
    }
    main = closed.model

    await showMainFrame()

    expect(editorTabsAndFiles()).toEqual([])
    expect(useAppStore.getState().openFiles.map((file) => file.id)).toEqual(['/repo-a/c.ts'])
  })
})
