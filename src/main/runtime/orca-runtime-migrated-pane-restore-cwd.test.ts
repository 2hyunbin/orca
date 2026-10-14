// A pane moved to this host reopens in the folder it last used on the source, exactly once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import { OrcadTerminalRestoreHintStore } from '../persistence/migrating-orcad-catalog/orcad-terminal-restore-hint-store'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const MIGRATION_KEY = 'a'.repeat(32)

let dir: string
let worktreePath: string

class MigratedPaneRuntime extends OrcaRuntimeService {
  constructor(
    store: RuntimeStore,
    private readonly connectionId: string | null
  ) {
    super(store)
  }

  protected override async resolveTerminalWorkspaceLaunchScope(): Promise<TerminalWorkspaceLaunchScope> {
    return {
      id: 'wt-1',
      path: worktreePath,
      connectionId: this.connectionId,
      repo: null,
      folderWorkspace: null
    }
  }
}

function runtimeWithHints(
  hints: { paneKey: string; cwd: string }[],
  connectionId: string | null = null
): {
  runtime: MigratedPaneRuntime
  spawn: ReturnType<typeof vi.fn>
  hintStore: OrcadTerminalRestoreHintStore
} {
  const hintStore = new OrcadTerminalRestoreHintStore(join(dir, 'blobs'))
  hintStore.install(MIGRATION_KEY, hints, Date.now())
  const store: RuntimeStore = {
    getRepos: () => [],
    getRepo: () => undefined,
    addRepo: vi.fn<RuntimeStore['addRepo']>(),
    updateRepo: vi.fn<RuntimeStore['updateRepo']>(),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: vi.fn<RuntimeStore['setWorktreeMeta']>(),
    removeWorktreeMeta: vi.fn<RuntimeStore['removeWorktreeMeta']>(),
    getGitHubCache: vi.fn<RuntimeStore['getGitHubCache']>(),
    getSettings: () => ({
      workspaceDir: '/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    takeOrcadMigrationTerminalRestoreHint: (paneKey) => hintStore.take(paneKey, Date.now())
  }
  const runtime = new MigratedPaneRuntime(store, connectionId)
  const spawn = vi.fn(async () => ({ id: `pty-${spawn.mock.calls.length}` }))
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, spawn, hintStore }
}

function spawnedCwd(spawn: ReturnType<typeof vi.fn>, call: number): unknown {
  const args: unknown = spawn.mock.calls[call]?.[0]
  return typeof args === 'object' && args !== null && 'cwd' in args ? args.cwd : undefined
}

describe('migrated pane restore cwd at terminal create', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-migrated-pane-cwd-'))
    worktreePath = join(dir, 'repo')
    mkdirSync(join(worktreePath, 'packages', 'web'), { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('opens a default-cwd create in the hinted folder once, then at the worktree root', async () => {
    const hinted = join(worktreePath, 'packages', 'web')
    const { runtime, spawn } = runtimeWithHints([{ paneKey: `${TAB_ID}:${LEAF_ID}`, cwd: hinted }])

    await runtime.createTerminal('id:wt-1', { tabId: TAB_ID, leafId: LEAF_ID })
    await runtime.createTerminal('id:wt-1', { tabId: TAB_ID, leafId: LEAF_ID })

    expect(spawnedCwd(spawn, 0)).toBe(hinted)
    expect(spawnedCwd(spawn, 1)).toBe(worktreePath)
  })

  it('keeps an explicit cwd and leaves the hint for a later default create', async () => {
    const hinted = join(worktreePath, 'packages', 'web')
    const { runtime, spawn, hintStore } = runtimeWithHints([
      { paneKey: `${TAB_ID}:${LEAF_ID}`, cwd: hinted }
    ])

    await runtime.createTerminal('id:wt-1', { tabId: TAB_ID, leafId: LEAF_ID, cwd: dir })

    expect(spawnedCwd(spawn, 0)).toBe(dir)
    expect(hintStore.take(`${TAB_ID}:${LEAF_ID}`, Date.now())).toBe(hinted)
  })

  it('falls back to the worktree root and drops a hint whose folder is gone', async () => {
    const { runtime, spawn, hintStore } = runtimeWithHints([
      { paneKey: `${TAB_ID}:${LEAF_ID}`, cwd: join(worktreePath, 'deleted') }
    ])

    await runtime.createTerminal('id:wt-1', { tabId: TAB_ID, leafId: LEAF_ID })

    expect(spawnedCwd(spawn, 0)).toBe(worktreePath)
    expect(hintStore.take(`${TAB_ID}:${LEAF_ID}`, Date.now())).toBeNull()
  })

  it("never applies another pane's hint", async () => {
    const hinted = join(worktreePath, 'packages', 'web')
    const { runtime, spawn, hintStore } = runtimeWithHints([
      { paneKey: `${TAB_ID}:${OTHER_LEAF_ID}`, cwd: hinted }
    ])

    await runtime.createTerminal('id:wt-1', { tabId: TAB_ID, leafId: LEAF_ID })
    await runtime.createTerminal('id:wt-1', {})

    expect(spawnedCwd(spawn, 0)).toBe(worktreePath)
    expect(spawnedCwd(spawn, 1)).toBe(worktreePath)
    expect(hintStore.take(`${TAB_ID}:${OTHER_LEAF_ID}`, Date.now())).toBe(hinted)
  })

  it('ignores hints for an SSH workspace, whose folders this host cannot check', async () => {
    const hinted = join(worktreePath, 'packages', 'web')
    const { runtime, spawn, hintStore } = runtimeWithHints(
      [{ paneKey: `${TAB_ID}:${LEAF_ID}`, cwd: hinted }],
      'ssh-1'
    )

    await runtime.createTerminal('id:wt-1', { tabId: TAB_ID, leafId: LEAF_ID })

    expect(spawnedCwd(spawn, 0)).toBe(worktreePath)
    expect(hintStore.take(`${TAB_ID}:${LEAF_ID}`, Date.now())).toBe(hinted)
  })
})
