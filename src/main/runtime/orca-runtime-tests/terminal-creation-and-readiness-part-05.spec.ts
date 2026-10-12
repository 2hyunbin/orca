import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  getDefaultWorkspaceSession,
  join,
  mkdtemp,
  tmpdir
} from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_FOLDER_PROJECT_GROUP_ID,
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createFolderWorkspaceRuntimeStore,
  expectStablePaneKeyEnv,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('splits a saved pty-backed terminal session into its parent tab', async () => {
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-source' })
      .mockResolvedValueOnce({ id: 'pty-split' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const sourceEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}

    const split = await runtime.splitTerminal(handle, { direction: 'vertical' })
    expect(split).toMatchObject({
      handle: expect.stringMatching(/^term_/),
      tabId: sourceEnv.ORCA_TAB_ID,
      paneRuntimeId: -1
    })

    const splitEnv =
      (spawn.mock.calls[1]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    const splitLeafId = splitEnv.ORCA_PANE_KEY.slice(`${sourceEnv.ORCA_TAB_ID}:`.length)
    expect(split.leafId).toBe(splitLeafId)
    expect(splitEnv.ORCA_TAB_ID).toBe(sourceEnv.ORCA_TAB_ID)
    expect(splitEnv.ORCA_WORKTREE_ID).toBe(TEST_WORKTREE_ID)
    expect(
      runtime
        .heldWorkspaceLayout(TEST_WORKTREE_ID)
        ?.tabs.find((tab) => tab.kind === 'terminal' && tab.entityId === sourceEnv.ORCA_TAB_ID)
    ).toMatchObject({ panes: { root: { type: 'split', direction: 'vertical' } } })

    // Why: client renders the tab from one sibling's parentLayout, so all siblings must carry the direction or Split Right flips down.
    const publishedTabs = (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs
    const siblingSurfaces = publishedTabs.filter(
      (tab): tab is Extract<typeof tab, { type: 'terminal' }> =>
        tab.type === 'terminal' && tab.parentTabId === sourceEnv.ORCA_TAB_ID
    )
    expect(siblingSurfaces.length).toBe(2)
    for (const surface of siblingSurfaces) {
      expect(surface.parentLayout?.root).toMatchObject({ type: 'split', direction: 'vertical' })
    }
  })

  it('keeps a persisted split when the window mounts its tab during the spawn', async () => {
    const tabId = 'persisted-mounted-tab'
    const ptyId = 'persisted-mounted-pty'
    const splitPtyId = 'persisted-mounted-split-pty'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: tabId,
              ptyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Persisted terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          [tabId]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
        }
      })
    )
    const kill = vi.fn(() => true)
    let resolveSpawn!: (result: { id: string }) => void
    const spawn = vi.fn(
      (_args: unknown) =>
        new Promise<{ id: string }>((resolve) => {
          resolveSpawn = resolve
        })
    )
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID,
      incarnationId: 'live-source-incarnation'
    })
    const internals = runtime as unknown as {
      issuePtyHandle: (pty: unknown) => string
      ptysById: Map<string, unknown>
    }
    const handle = internals.issuePtyHandle(internals.ptysById.get(ptyId))
    const split = runtime.splitTerminal(handle, { direction: 'horizontal' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    const splitSpawn = spawn.mock.calls[0]?.[0] as
      | { expectedSourceBinding?: { incarnationId?: string } }
      | undefined
    // Why: persistence never recorded an incarnation for this pane, so sending the live-only id
    // would make the store's fence reject every split from a restored session.
    expect(splitSpawn?.expectedSourceBinding).not.toHaveProperty('incarnationId')

    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          title: 'Persisted terminal',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: { type: 'leaf', leafId: HEADLESS_LEAF_ID }
        }
      ],
      leaves: [
        {
          tabId,
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId
        }
      ]
    })
    resolveSpawn({ id: splitPtyId })

    await expect(split).resolves.toMatchObject({
      tabId,
      handle: expect.stringMatching(/^term_/)
    })

    expect(kill).not.toHaveBeenCalled()
    expect(getSession().terminalLayoutsByTabId[tabId]?.root).toMatchObject({
      type: 'split',
      direction: 'horizontal'
    })
  })

  it('rejects a persisted split closed during spawn without recreating its tab', async () => {
    const tabId = 'closing-persisted-tab'
    const ptyId = 'closing-persisted-pty'
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: tabId,
              ptyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'Closing terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          [tabId]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: ptyId })
        }
      })
    )
    let resolveSpawn!: (result: { id: string }) => void
    const spawn = vi.fn(
      (_args: unknown) =>
        new Promise<{ id: string }>((resolve) => {
          resolveSpawn = resolve
        })
    )
    const kill = vi.fn(() => false)
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty(ptyId, TEST_WORKTREE_ID, null, {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const internals = runtime as unknown as {
      issuePtyHandle: (pty: unknown) => string
      ptysById: Map<string, unknown>
    }
    const handle = internals.issuePtyHandle(internals.ptysById.get(ptyId))
    const split = runtime.splitTerminal(handle, { direction: 'vertical' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())

    setSession(getDefaultWorkspaceSession())
    runtimeStore.persistPtyBinding.mockResolvedValue(false)
    resolveSpawn({ id: 'rejected-split-pty' })

    await expect(split).rejects.toThrow('terminal_split_source_not_found')
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      runtimeAdmittedPane: true,
      placement: {
        kind: 'split',
        parentLeafId: HEADLESS_LEAF_ID,
        direction: 'vertical'
      },
      expectedSourceBinding: {
        worktreeId: TEST_WORKTREE_ID,
        tabId,
        leafId: HEADLESS_LEAF_ID,
        ptyId
      }
    })
    expect(kill).toHaveBeenCalledWith('rejected-split-pty')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toBeUndefined()
    expect(getSession().terminalLayoutsByTabId[tabId]).toBeUndefined()
  })

  it('rejects a split whose runtime-created source closed during spawn before publishing it', async () => {
    let resolveSplitSpawn!: (result: { id: string }) => void
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'projected-source-pty' })
      .mockImplementationOnce(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveSplitSpawn = resolve
          })
      )
    const kill = vi.fn(() => true)
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const split = runtime.splitTerminal(handle, { direction: 'vertical' })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))

    // Another writer (the window) saves a session without the source tab.
    store.setWorkspaceSession(getDefaultWorkspaceSession())
    resolveSplitSpawn({ id: 'orphaned-split-pty' })

    await expect(split).rejects.toThrow('terminal_split_source_not_found')
    expect(kill).toHaveBeenCalledWith('orphaned-split-pty')
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('splits a saved folder workspace pty-backed terminal session with folder cwd and env', async () => {
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-runtime-folder-split-'))
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-folder-source' })
      .mockResolvedValueOnce({ id: 'pty-folder-split' })
    const folderWorkspace = makeFolderWorkspace({ folderPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(TEST_FOLDER_WORKSPACE_KEY)
    const sourceCall = spawn.mock.calls[0]?.[0] as
      | { cwd?: string; env?: Record<string, string>; worktreeId?: string }
      | undefined
    const sourceEnv = sourceCall?.env ?? {}

    await expect(runtime.splitTerminal(handle, { direction: 'vertical' })).resolves.toMatchObject({
      handle: expect.stringMatching(/^term_/),
      tabId: sourceEnv.ORCA_TAB_ID,
      paneRuntimeId: -1
    })

    const splitCall = spawn.mock.calls[1]?.[0] as
      | { cwd?: string; env?: Record<string, string>; worktreeId?: string }
      | undefined
    const splitEnv = splitCall?.env ?? {}
    expect(sourceCall).toMatchObject({
      cwd: folderPath,
      worktreeId: TEST_FOLDER_WORKSPACE_KEY
    })
    expect(splitCall).toMatchObject({
      cwd: folderPath,
      worktreeId: TEST_FOLDER_WORKSPACE_KEY
    })
    expectStablePaneKeyEnv(splitEnv)
    expect(splitEnv.ORCA_TAB_ID).toBe(sourceEnv.ORCA_TAB_ID)
    expect(splitEnv.ORCA_WORKSPACE_ID).toBe(TEST_FOLDER_WORKSPACE_KEY)
    expect(splitEnv.ORCA_PROJECT_GROUP_ID).toBe(TEST_FOLDER_PROJECT_GROUP_ID)
    expect(splitEnv.ORCA_WORKSPACE_ROOT).toBe(folderPath)
    expect(splitEnv.ORCA_WORKTREE_ID).toBe(TEST_FOLDER_WORKSPACE_KEY)
    expect(
      runtime
        .heldWorkspaceLayout(TEST_FOLDER_WORKSPACE_KEY)
        ?.tabs.find((tab) => tab.kind === 'terminal' && tab.entityId === sourceEnv.ORCA_TAB_ID)
    ).toMatchObject({ panes: { root: { type: 'split', direction: 'vertical' } } })
  })

  it('atomically admits persisted SSH splits in the SSH host partition', async () => {
    const tabId = 'ssh-split-tab'
    const sourcePtyId = 'ssh:ssh-1@@source-pty'
    const splitPtyId = 'ssh:ssh-1@@split-pty'
    const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        tabsByWorktree: {
          [TEST_WORKTREE_ID]: [
            {
              id: tabId,
              ptyId: sourcePtyId,
              worktreeId: TEST_WORKTREE_ID,
              title: 'SSH terminal',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        terminalLayoutsByTabId: {
          [tabId]: makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: sourcePtyId })
        }
      }),
      'ssh:ssh-1'
    )
    const spawn = vi.fn().mockResolvedValue({ id: splitPtyId })
    const runtime = new OrcaRuntimeService({
      ...runtimeStore,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.registerPty(sourcePtyId, TEST_WORKTREE_ID, 'ssh-1', {
      tabId,
      leafId: HEADLESS_LEAF_ID
    })
    const internals = runtime as unknown as {
      issuePtyHandle: (pty: unknown) => string
      ptysById: Map<string, unknown>
    }
    const handle = internals.issuePtyHandle(internals.ptysById.get(sourcePtyId))

    await expect(runtime.splitTerminal(handle, { direction: 'vertical' })).resolves.toMatchObject({
      tabId,
      handle: expect.stringMatching(/^term_/)
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ssh-1',
        worktreeId: TEST_WORKTREE_ID,
        runtimeAdmittedPane: true,
        expectedSourceBinding: expect.objectContaining({
          worktreeId: TEST_WORKTREE_ID,
          tabId,
          leafId: HEADLESS_LEAF_ID,
          ptyId: sourcePtyId
        })
      })
    )
    expect(getSession().terminalLayoutsByTabId[tabId]?.root).toMatchObject({
      type: 'split',
      direction: 'vertical'
    })
  })

  it('does not warn when a default create has no renderer notifier', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    expect(created).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      surface: 'visible',
      handle: expect.stringMatching(/^term_/)
    })
    expect(created.warning).toBeUndefined()
  })

  it('does not warn when background presentation has no renderer notifier', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      presentation: 'background'
    })

    expect(created).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      surface: 'background',
      handle: expect.stringMatching(/^term_/)
    })
    expect(created.warning).toBeUndefined()
  })
})
