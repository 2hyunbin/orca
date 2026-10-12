import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime'
import { terminalSurfaceCloseMutation } from './terminal-surface-close'
import { capturePersistedTerminalTabCopy } from './workspace-session-terminal-tab-retirement-identity'

const REPO = {
  id: 'repo',
  path: '/worktree',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
} as const
const WORKTREE_ID = 'repo::/worktree'
const LEAF = '11111111-1111-4111-8111-111111111111'
const UNRELATED_LEAF = '22222222-2222-4222-8222-222222222222'
const SPILL_HOST_ID: ExecutionHostId = 'runtime:env-1'

function terminalTab(id: string, ptyId: string) {
  return {
    id,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function sessionWithTab(id: string, ptyId: string, leaf = LEAF): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [WORKTREE_ID]: [terminalTab(id, ptyId)] },
    terminalLayoutsByTabId: {
      [id]: {
        root: { type: 'leaf', leafId: leaf },
        activeLeafId: leaf,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leaf]: ptyId }
      }
    },
    terminalPtyIncarnationsByPaneKey: { [`${id}:${leaf}`]: `${id}-incarnation` }
  }
}

function harness(sessions: Map<ExecutionHostId, WorkspaceSessionState>) {
  const kill = vi.fn(() => true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This runtime fixture supplies the persistence methods exercised by the test.
  const store = withDurableRuntimeStore({
    getRepos: () => [REPO],
    getRepo: (id: string) => (id === REPO.id ? REPO : undefined),
    getWorktreeMeta: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getWorkspaceSessionHostIds: () => [...sessions.keys()],
    getWorkspaceSession: (hostId?: ExecutionHostId) =>
      sessions.get(hostId ?? LOCAL_EXECUTION_HOST_ID) ?? getDefaultWorkspaceSession(),
    setWorkspaceSession: (session: WorkspaceSessionState, hostId?: ExecutionHostId) =>
      sessions.set(hostId ?? LOCAL_EXECUTION_HOST_ID, session),
    flushOrThrow: vi.fn()
  }) as never
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    write: () => true,
    kill,
    getForegroundProcess: async () => null,
    listProcesses: async () => [{ id: 'target-pty', cwd: REPO.path, title: 'Terminal' }]
  })
  return { runtime, kill }
}

/** The tab ids a fresh runtime over these partitions loads into the local worktree. */
function localTabIds(sessions: Map<ExecutionHostId, WorkspaceSessionState>): string[] {
  const workspace =
    harness(sessions).runtime['layoutHolder'].model(LOCAL_EXECUTION_HOST_ID)?.workspaces[
      WORKTREE_ID
    ]
  return workspace?.tabs.map((tab) => tab.id) ?? []
}

const listsTarget = (session: WorkspaceSessionState | undefined): boolean =>
  session?.tabsByWorktree[WORKTREE_ID]?.some((tab) => tab.id === 'target') === true

// The local load moves a spill copy into the local partition, so the close runs on the local tab
// and no spill copy is left to bring it back. Held closes record no tombstone (deleted in 6h).
describe('terminal close across local and runtime session partitions (#18202)', () => {
  it('closes a tab persisted only in a runtime spill partition', async () => {
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      [LOCAL_EXECUTION_HOST_ID, sessionWithTab('unrelated', 'unrelated-pty', UNRELATED_LEAF)],
      [SPILL_HOST_ID, sessionWithTab('target', 'target-pty')]
    ])
    const { runtime, kill } = harness(sessions)
    expect(listsTarget(sessions.get(LOCAL_EXECUTION_HOST_ID))).toBe(true)
    expect(listsTarget(sessions.get(SPILL_HOST_ID))).toBe(false)
    runtime.registerPty('target-pty', WORKTREE_ID, null, {
      tabId: 'target',
      leafId: LEAF,
      incarnationId: 'target-incarnation'
    })

    const terminal = (await runtime.listTerminals()).terminals.find(
      (candidate) => candidate.tabId === 'target'
    )!
    await expect(runtime.closeTerminalTab(terminal.handle)).resolves.toMatchObject({
      tabId: 'target'
    })

    const local = sessions.get(LOCAL_EXECUTION_HOST_ID)!
    expect(local.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['unrelated'])
    expect(local.terminalLayoutsByTabId.target).toBeUndefined()
    expect(kill).toHaveBeenCalledWith('target-pty')
    expect(localTabIds(sessions)).toEqual(['unrelated'])
  })

  it('closes the one folded tab when legacy reattach left a copy in two partitions', async () => {
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      [LOCAL_EXECUTION_HOST_ID, sessionWithTab('unrelated', 'unrelated-pty', UNRELATED_LEAF)],
      [SPILL_HOST_ID, sessionWithTab('target', 'target-pty')],
      ['runtime:env-0', sessionWithTab('target', 'target-pty')]
    ])
    const { runtime, kill } = harness(sessions)
    expect(listsTarget(sessions.get(SPILL_HOST_ID))).toBe(false)
    expect(listsTarget(sessions.get('runtime:env-0'))).toBe(false)
    runtime.registerPty('target-pty', WORKTREE_ID, null, {
      tabId: 'target',
      leafId: LEAF,
      incarnationId: 'target-incarnation'
    })

    const terminal = (await runtime.listTerminals()).terminals.find(
      (candidate) => candidate.tabId === 'target'
    )!
    await expect(runtime.closeTerminalTab(terminal.handle)).resolves.toMatchObject({
      tabId: 'target'
    })

    expect(kill).toHaveBeenCalledWith('target-pty')
    expect(localTabIds(sessions)).toEqual(['unrelated'])
  })

  it('keeps a spill copy when the local partition cannot take it', () => {
    const spill = sessionWithTab('target', 'target-pty')
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      [LOCAL_EXECUTION_HOST_ID, sessionWithTab('unrelated', 'unrelated-pty', UNRELATED_LEAF)],
      [SPILL_HOST_ID, spill]
    ])
    const refusing = new Map(sessions)
    refusing.set = (hostId, session) => {
      if (hostId === LOCAL_EXECUTION_HOST_ID) {
        throw new Error('profile_write_refused')
      }
      return Map.prototype.set.call(refusing, hostId, session)
    }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    harness(refusing)

    expect(refusing.get(SPILL_HOST_ID)).toBe(spill)
  })

  it('refuses when a second copy was rebound after the close was asked', () => {
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      [SPILL_HOST_ID, sessionWithTab('target', 'target-pty')],
      ['runtime:env-0', sessionWithTab('target', 'target-pty')]
    ])
    const requestedHolders = new Map(
      [...sessions].map(([hostId, session]) => [
        hostId,
        capturePersistedTerminalTabCopy(session, WORKTREE_ID, 'target')
      ])
    )
    // In place, as the binding writer rebinds a session it holds.
    const second = sessions.get('runtime:env-0')!
    second.terminalLayoutsByTabId.target!.ptyIdsByLeafId = { [LEAF]: 'replacement-pty' }
    second.terminalPtyIncarnationsByPaneKey = { [`target:${LEAF}`]: 'replacement-incarnation' }
    const setSession = vi.fn()
    const onClosed = vi.fn()

    const mutation = terminalSurfaceCloseMutation({
      worktreeId: WORKTREE_ID,
      target: { kind: 'tab', tabId: 'target' },
      options: {},
      requestedSession: sessions.get(SPILL_HOST_ID),
      requestedHolders,
      ownerMatches: () => true,
      hostIds: () => [...sessions.keys()],
      getSession: (hostId) => sessions.get(hostId),
      setSession,
      onClosed
    })()

    expect(mutation).toEqual({
      value: new Error('terminal_pane_owner_changed'),
      persist: false
    })
    expect(setSession).not.toHaveBeenCalled()
    expect(onClosed).not.toHaveBeenCalled()
  })

  it("leaves a server workspace's tabs in its runtime partition: only a local record proves a spill", () => {
    const serverWorktree = 'server-repo::/srv/wt'
    const server = sessionWithTab('srv-tab', 'remote:env-1@@srv-pty')
    server.tabsByWorktree = {
      [serverWorktree]: server.tabsByWorktree[WORKTREE_ID]!.map((tab) => ({
        ...tab,
        worktreeId: serverWorktree
      }))
    }
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      [LOCAL_EXECUTION_HOST_ID, sessionWithTab('unrelated', 'unrelated-pty', UNRELATED_LEAF)],
      [SPILL_HOST_ID, server]
    ])
    const { runtime } = harness(sessions)

    const local = runtime['layoutHolder'].model(LOCAL_EXECUTION_HOST_ID)
    expect(local?.workspaces[serverWorktree]).toBeUndefined()
    expect(sessions.get(SPILL_HOST_ID)).toBe(server)
  })

  it('keeps the pin guard of the partition that holds the tab', async () => {
    const spill = sessionWithTab('target', 'target-pty')
    spill.tabsByWorktree[WORKTREE_ID] = [{ ...terminalTab('target', 'target-pty'), isPinned: true }]
    const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
      [LOCAL_EXECUTION_HOST_ID, sessionWithTab('unrelated', 'unrelated-pty', UNRELATED_LEAF)],
      [SPILL_HOST_ID, spill]
    ])
    const { runtime, kill } = harness(sessions)
    const local = sessions.get(LOCAL_EXECUTION_HOST_ID)

    await expect(runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, 'target')).rejects.toThrow(
      'terminal_tab_pinned'
    )
    expect(sessions.get(LOCAL_EXECUTION_HOST_ID)).toEqual(local)
    expect(local?.tabsByWorktree[WORKTREE_ID]?.find((tab) => tab.id === 'target')?.isPinned).toBe(
      true
    )
    expect(kill).not.toHaveBeenCalled()
  })
})
