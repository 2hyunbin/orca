// L80 (P3): with the switch on, a pane main owns is no proof its terminal runs; the host's
// inventory and the terminal's record decide. Switch-off, a window leaf still vouches for its pty.
import { afterEach, describe, expect, it, vi } from 'vitest'

const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

await import('../../orca-runtime-test-mocks.spec')
await import('../../orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime-test-mocks.spec')
const { toAppSshPtyId } = await import('../../../../shared/ssh-pty-id')
const {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_FOLDER_WORKSPACE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../../orca-runtime-test-fixtures.spec')

const SSH_PTY = toAppSshPtyId('ssh-target', 'relay-pty')

type Host = { live: Set<string> }

/** Each provider lists only its own shells; the SSH relay answers for `ssh:ssh-target`. */
function hostController(host: Host, cwd: string, worktreeId: string) {
  return {
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    hasPty: (ptyId: string) => host.live.has(ptyId),
    listProcesses: async (providerKey?: string) =>
      [...host.live]
        .filter((id) => (id === SSH_PTY) === (providerKey === 'ssh:ssh-target'))
        .map((id) => ({ id, title: 'shell', cwd, worktreeId, wslDistro: null }))
  }
}

/** One inventory sweep of a single provider, as a workspace listing or a relay refresh runs it. */
async function sweepProvider(runtime: object, connectionId: string | null): Promise<void> {
  const refresh: unknown = Reflect.get(runtime, 'refreshPtyWorktreeRecordsWithControllerInventory')
  if (typeof refresh !== 'function') {
    throw new Error('needs the runtime inventory refresh')
  }
  await Reflect.apply(refresh, runtime, [[], null, undefined, connectionId])
}

/** A host whose saved `host-tab` pane binds `ptyId`, live until the test drops it from `host.live`. */
function savedPaneHost(ptyId: string, opts: { windowed?: boolean; splitPtyId?: string } = {}) {
  const host: Host = { live: new Set([ptyId]) }
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Saved',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({
          [HEADLESS_LEAF_ID]: ptyId,
          ...(opts.splitPtyId ? { [HEADLESS_SECOND_LEAF_ID]: opts.splitPtyId } : {})
        })
      }
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared runtime spec fixture store implements every method these paths call.
  const runtime = new OrcaRuntimeService(runtimeStore as never)
  runtime.setPtyController(hostController(host, TEST_WORKTREE_PATH, TEST_WORKTREE_ID))
  const graph = {
    tabs: [
      {
        tabId: 'host-tab',
        worktreeId: TEST_WORKTREE_ID,
        title: 'Saved',
        activeLeafId: HEADLESS_LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'host-tab',
        worktreeId: TEST_WORKTREE_ID,
        leafId: HEADLESS_LEAF_ID,
        paneRuntimeId: 1,
        ptyId,
        paneTitle: 'Saved'
      }
    ]
  }
  if (opts.windowed) {
    runtime.attachWindow(1)
  }
  const publishWindowGraph = (): void => {
    runtime.syncWindowGraph(opts.windowed ? 1 : 0, opts.windowed ? graph : { tabs: [], leaves: [] })
  }
  publishWindowGraph()
  return { runtime, host, publishWindowGraph }
}

async function rowStatus(runtime: InstanceType<typeof OrcaRuntimeService>, worktree: string) {
  const listed = await runtime.listMobileSessionTabs(`id:${worktree}`)
  const row = listed.tabs.find((tab) => tab.type === 'terminal')
  return row?.type === 'terminal' ? row.status : null
}

const record = (runtime: object, ptyId: string) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test reads the runtime's protected record map.
  (runtime as { ptysById: Map<string, { connected: boolean }> }).ptysById.get(ptyId)

afterEach(() => {
  layoutOwner.isMain = true
})

describe('a pane main owns does not vouch for its terminal (switch on)', () => {
  it('reads a headless pane disconnected once the host stops listing its shell', async () => {
    const { runtime, host } = savedPaneHost('saved-pty')
    expect(await rowStatus(runtime, TEST_WORKTREE_ID)).toBe('ready')

    host.live.clear()

    expect(await rowStatus(runtime, TEST_WORKTREE_ID)).toBe('pending-handle')
    expect(record(runtime, 'saved-pty')?.connected).toBe(false)
  })

  it('reads a windowed pane disconnected, and a window republish does not reconnect it', async () => {
    const { runtime, host, publishWindowGraph } = savedPaneHost('saved-pty', { windowed: true })
    expect(await rowStatus(runtime, TEST_WORKTREE_ID)).toBe('ready')

    host.live.clear()
    expect(await rowStatus(runtime, TEST_WORKTREE_ID)).toBe('pending-handle')
    publishWindowGraph()
    await new Promise((resolve) => setImmediate(resolve))

    expect(record(runtime, 'saved-pty')?.connected).toBe(false)
    expect(await rowStatus(runtime, TEST_WORKTREE_ID)).toBe('pending-handle')
  })

  it('never shows a restored pane not ready while its shell is listed', async () => {
    const { runtime } = savedPaneHost('saved-pty', { windowed: true })
    const statuses: string[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
      for (const tab of snapshot.tabs) {
        if (tab.type === 'terminal') {
          statuses.push(tab.status)
        }
      }
    })

    expect(await rowStatus(runtime, TEST_WORKTREE_ID)).toBe('ready')
    await new Promise((resolve) => setImmediate(resolve))
    unsubscribe()

    expect(statuses.filter((status) => status !== 'ready')).toEqual([])
  })

  it('leaves an SSH pane to the relay: a local sweep is not absence, the relay omitting it is', async () => {
    const { runtime, host } = savedPaneHost(SSH_PTY)
    runtime.registerPty(SSH_PTY, TEST_WORKTREE_ID, 'ssh-target', {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    await sweepProvider(runtime, 'ssh-target')
    expect(record(runtime, SSH_PTY)?.connected).toBe(true)

    // Only the local host answers: it cannot prove the relay's shell gone.
    host.live.delete(SSH_PTY)
    await sweepProvider(runtime, null)
    expect(record(runtime, SSH_PTY)?.connected).toBe(true)

    // The relay answers without the shell: disconnected, never a certified exit.
    await sweepProvider(runtime, 'ssh-target')
    expect(record(runtime, SSH_PTY)?.connected).toBe(false)
    expect(runtime.getPtyLivenessVerdict(SSH_PTY)?.status).not.toBe('exited')
  })

  it('applies the same rule to a folder workspace', async () => {
    const host: Host = { live: new Set(['folder-pty']) }
    const session = makeWorkspaceSessionWithHeadlessTerminal({
      activeWorktreeId: TEST_FOLDER_WORKSPACE_KEY,
      tabsByWorktree: {
        [TEST_FOLDER_WORKSPACE_KEY]: [
          {
            id: 'folder-tab',
            ptyId: 'folder-pty',
            worktreeId: TEST_FOLDER_WORKSPACE_KEY,
            title: 'Folder',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'folder-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'folder-pty' })
      }
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(session)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared runtime spec fixture store implements every method these paths call.
    const runtime = new OrcaRuntimeService({
      ...runtimeStore,
      getFolderWorkspaces: () => [makeFolderWorkspace()],
      getProjectGroups: () => [makeFolderProjectGroup()]
    } as never)
    runtime.setPtyController(
      hostController(host, TEST_FOLDER_WORKSPACE_PATH, TEST_FOLDER_WORKSPACE_KEY)
    )
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    expect(await rowStatus(runtime, TEST_FOLDER_WORKSPACE_KEY)).toBe('ready')

    host.live.clear()

    expect(await rowStatus(runtime, TEST_FOLDER_WORKSPACE_KEY)).toBe('pending-handle')
  })
})

describe('a launch into a pane through a listing gap (switch on)', () => {
  it('treats a disconnected terminal main still binds as running until its exit is certified', async () => {
    const { runtime, host } = savedPaneHost('saved-pty', { windowed: true })
    const paneKey = `host-tab:${HEADLESS_LEAF_ID}`
    await rowStatus(runtime, TEST_WORKTREE_ID)
    expect(runtime.hasLiveTerminalForPaneKey(paneKey)).toBe(true)

    // The host omits the shell once: an agent launch must attach or refuse, never start a second.
    host.live.clear()
    await rowStatus(runtime, TEST_WORKTREE_ID)
    expect(record(runtime, 'saved-pty')?.connected).toBe(false)
    expect(runtime.hasLiveTerminalForPaneKey(paneKey)).toBe(true)

    await runtime.onPtyExit('saved-pty', 0)
    expect(runtime.hasLiveTerminalForPaneKey(paneKey)).toBe(false)
  })
})

describe('stopping a workspace through a listing gap (switch on)', () => {
  it('still targets a disconnected terminal main binds, and never reports it stopped unproven', async () => {
    const { runtime, host } = savedPaneHost('saved-pty', { windowed: true })
    await rowStatus(runtime, TEST_WORKTREE_ID)
    host.live.clear()
    await rowStatus(runtime, TEST_WORKTREE_ID)
    expect(record(runtime, 'saved-pty')?.connected).toBe(false)

    const liveIds: unknown = Reflect.apply(
      Reflect.get(runtime, 'getLivePtyIdsForWorktree'),
      runtime,
      [TEST_WORKTREE_ID]
    )
    expect(liveIds).toEqual(new Set(['saved-pty']))

    // The host answered it has no such id, which cannot prove the shell gone (a restarted host can
    // omit survivors), and the kill draws no exit: the shell may still run.
    expect(runtime.getPtyLivenessVerdict('saved-pty')).toBeNull()
    const result = await runtime.closeTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    expect(result).toMatchObject({ ptyStopVerdict: 'unverifiable' })
  })
})

describe('an exit wait through a listing gap (switch on)', () => {
  it('keeps waiting on a disconnected terminal main binds until its exit is certified', async () => {
    const { runtime, host } = savedPaneHost('saved-pty', { windowed: true })
    await rowStatus(runtime, TEST_WORKTREE_ID)
    const handle = runtime.resolveTerminalPane(
      `host-tab:${HEADLESS_LEAF_ID}`,
      TEST_WORKTREE_ID
    ).handle
    host.live.clear()
    await rowStatus(runtime, TEST_WORKTREE_ID)
    expect(record(runtime, 'saved-pty')?.connected).toBe(false)

    // A listing gap is no exit: the wait runs to the caller's timeout instead of answering `unknown`.
    await expect(
      runtime.waitForTerminal(handle, { condition: 'exit', timeoutMs: 50 })
    ).rejects.toThrow('timeout')

    const waiting = runtime.waitForTerminal(handle, { condition: 'exit', timeoutMs: 5_000 })
    await runtime.onPtyExit('saved-pty', 3)
    await expect(waiting).resolves.toMatchObject({ satisfied: true })
  })
})

describe('a terminal registered while a listing is in flight (switch on)', () => {
  it('stays connected: the listing that started before it cannot prove it absent', async () => {
    // Main's layout binds the split's pane before its shell registers, as the spawn commit does.
    const { runtime, host } = savedPaneHost('saved-pty', {
      windowed: true,
      splitPtyId: 'split-pty'
    })
    await rowStatus(runtime, TEST_WORKTREE_ID)
    let answer!: () => void
    const answered = new Promise<void>((resolve) => {
      answer = resolve
    })
    const listedBeforeSpawn = [...host.live]
    Reflect.set(runtime, 'ptyController', {
      ...hostController(host, TEST_WORKTREE_PATH, TEST_WORKTREE_ID),
      hasPty: () => undefined,
      listProcesses: async () => {
        await answered
        return listedBeforeSpawn.map((id) => ({
          id,
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }))
      }
    })
    const listing = sweepProvider(runtime, null)

    // A split's shell commits while the host's answer, taken before it existed, is on its way.
    runtime.registerPty('split-pty', TEST_WORKTREE_ID, null, {
      tabId: 'host-tab',
      leafId: HEADLESS_SECOND_LEAF_ID
    })
    answer()
    await listing

    expect(record(runtime, 'split-pty')?.connected).toBe(true)
  })
})

describe('switch off: a window leaf still vouches for its terminal', () => {
  it('keeps a windowed pane connected when the inventory stops listing it', async () => {
    layoutOwner.isMain = false
    const { runtime, host } = savedPaneHost('saved-pty', { windowed: true })
    expect(await rowStatus(runtime, TEST_WORKTREE_ID)).toBe('ready')

    host.live.clear()

    expect(await rowStatus(runtime, TEST_WORKTREE_ID)).toBe('ready')
    expect(record(runtime, 'saved-pty')?.connected).toBe(true)
  })
})
