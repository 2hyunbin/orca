import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as TransportFixtureModule from '@/runtime/layout-apply-test-transport.test-fixture'
import {
  launchWorkspaceState,
  perClientLoader,
  type LaunchStoreHolder
} from '@/lib/launch-parity-renderer.test-fixture'
import { getDefaultSettings } from '../../../shared/constants'
import { makeAutomation, makeRun } from '@/components/automations/automations-page-fixtures'
import {
  AUTOMATION_LAUNCH_CASES,
  AUTOMATION_PROMPT,
  automationPhoneTab,
  automationSpawnRequest,
  type AutomationLaunchCase
} from '../../../shared/launch-parity-automation-cases.test-fixture'
import {
  LAUNCH_LEAF_ID,
  LAUNCH_TAB_ID,
  LAUNCH_TOKEN,
  launchWorkspaceId
} from '../../../shared/launch-parity-window-request.test-fixture'

// Main's answer to the window's layout commands, as a switch-on build sends them. The mocked
// client outlives each client's module reset, so its transport is kept here.
type TransportFixture = typeof TransportFixtureModule
const main = vi.hoisted((): { transport: TransportFixture['layoutApplyTestTransport'] | null } => ({
  transport: null
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const fixture = await import('@/runtime/layout-apply-test-transport.test-fixture')
  main.transport = fixture.layoutApplyTestTransport
  return fixture.runtimeRpcClientWithLayoutApply(await importOriginal())
})

const holder = vi.hoisted((): LaunchStoreHolder => ({ store: null }))
vi.mock('@/store', async () =>
  (await import('@/lib/launch-parity-renderer.test-fixture')).launchStoreModuleMock(holder)
)
// The stdin-after-start paste is pinned by launch-agent-background-session.test.ts.
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  registerEagerPtyBuffer: vi.fn(),
  subscribeToPtyExit: vi.fn(() => () => {})
}))
vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: vi.fn(() => () => {})
}))

const load = perClientLoader(async () => ({
  launch: await import('./launch-agent-background-session'),
  phone: await import('@/runtime/sync-runtime-graph/mobile-session-snapshots'),
  switch: await import('../../../shared/layout-owner-switch'),
  remoteCreate: await import('./runtime-agent-background-create'),
  remoteStream: await import('@/runtime/runtime-terminal-stream'),
  workspace: await import('@/hooks/automation-dispatch-workspace')
}))

/** Runs one automation in a local workspace. */
async function runAutomation(c: AutomationLaunchCase) {
  const modules = await load(c.client)
  const store = modules.createStore()
  holder.store = store
  store.setState(
    launchWorkspaceState(c.workspace, { ...getDefaultSettings('/home/alice'), ...c.settings })
  )
  const spawn = vi.fn(async (_request: Record<string, unknown>) => ({ id: 'pty-1' }))
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    api: { pty: { spawn, write: vi.fn(), kill: vi.fn() }, runtime: { call: vi.fn() } }
  })
  await modules.launch.launchAgentBackgroundSession({
    agent: c.agent,
    worktreeId: launchWorkspaceId(c.workspace),
    prompt: AUTOMATION_PROMPT,
    // Automation dispatch always passes 'unknown'.
    launchSource: 'unknown',
    title: c.title
  })
  const phone = modules.phone.buildMobileSessionTabSnapshots(store.getState(), false)
  if (modules.switch.ORCA_LAYOUT_OWNER_IS_MAIN) {
    // Main takes the run title by tab-bar id, and its frame (not modelled here) draws it.
    const tabBarId = store.getState().unifiedTabsByWorktree[launchWorkspaceId(c.workspace)]![0]!.id
    expect(main.transport?.sentOfType('renameTab').at(-1)).toEqual(
      expect.objectContaining({ tabId: tabBarId, kind: 'custom', title: c.title })
    )
    for (const snapshot of phone) {
      snapshot.tabs = snapshot.tabs.map((tab) => ({ ...tab, title: c.title }))
    }
  }
  return { spawn, phone }
}

/** Swaps the random tab, leaf and token ids for the table's fixed ones. */
function withFixedIds(value: unknown): unknown {
  const text = JSON.stringify(value)
  const ids = [
    ...new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g))
  ]
  const fixed = [LAUNCH_TAB_ID, LAUNCH_LEAF_ID, LAUNCH_TOKEN]
  return JSON.parse(ids.reduce((out, id, index) => out.replaceAll(id, fixed[index] ?? id), text))
}

// Pins main's current launch behaviour as the convergence parity baseline (row 5): the pty:spawn
// request a desktop automation sends and its phone tab. C7 replaces this producer.
describe('row 5: desktop automation pty:spawn request', () => {
  beforeAll(async () => {
    await load('darwin')
    await load('linux')
    await load('win32')
  }, 240_000)
  afterEach(() => vi.unstubAllGlobals())

  it.each([false, true])(
    'retains the selected standalone folder from preparation through launch with copied IDs (reverse=%s)',
    async (reverse) => {
      const modules = await load('darwin')
      const store = modules.createStore()
      holder.store = store
      store.setState(
        launchWorkspaceState(
          { kind: 'folder', path: '/selected/folder' },
          getDefaultSettings('/home/alice')
        )
      )
      const folder = { ...store.getState().folderWorkspaces[0]!, executionHostId: 'local' as const }
      const twin = {
        ...folder,
        executionHostId: 'ssh:other' as const,
        folderPath: '/foreign/folder'
      }
      const repo = {
        id: 'repo-1',
        path: '/selected',
        kind: 'folder' as const,
        displayName: 'Project',
        badgeColor: '#000',
        addedAt: 1
      }
      store.setState({
        folderWorkspaces: reverse ? [twin, folder] : [folder, twin],
        repos: [repo],
        activeWorktreeId: 'unrelated',
        activeWorkspaceExecutionHostId: 'ssh:other'
      })
      const automation = makeAutomation({
        workspaceMode: 'existing',
        workspaceId: `folder:${folder.id}`,
        projectId: repo.id,
        runContext: {
          kind: 'workspace-run',
          projectId: 'project',
          projectHostSetupId: 'setup',
          repoId: repo.id,
          path: repo.path,
          hostId: 'local'
        }
      })
      const run = makeRun({ trigger: 'manual' })
      const resolved = modules.workspace.resolveAutomationDispatchWorkspace(
        store.getState(),
        automation,
        run
      )
      if (!resolved.repo) {
        throw new Error('missing repo')
      }
      const markDispatchResult = vi.fn()
      const worktree = await modules.workspace.prepareAutomationDispatchWorkspace({
        state: store.getState(),
        automation,
        run,
        dispatchToken: 'token',
        resolved: { ...resolved, repo: resolved.repo },
        markDispatchResult
      })
      if (!worktree) {
        throw new Error('missing selected folder')
      }
      expect(worktree).toMatchObject({ path: '/selected/folder', hostId: 'local' })
      const spawn = vi.fn(async () => ({ id: 'pty-selected-folder' }))
      vi.stubGlobal('window', {
        dispatchEvent: vi.fn(),
        api: { pty: { spawn, write: vi.fn(), kill: vi.fn() }, runtime: { call: vi.fn() } }
      })
      await modules.launch.launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: worktree.id,
        resolvedTarget: { worktree, repo: resolved.repo },
        prompt: 'Selected folder task'
      })
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/selected/folder', connectionId: null })
      )
      expect(markDispatchResult).not.toHaveBeenCalled()
      store.setState({ folderWorkspaces: [twin] })
      await expect(
        modules.workspace.prepareAutomationDispatchWorkspace({
          state: store.getState(),
          automation,
          run,
          dispatchToken: 'token',
          resolved: { ...resolved, repo: resolved.repo },
          markDispatchResult
        })
      ).rejects.toThrow('worktree_execution_host_unresolved')
      expect(spawn).toHaveBeenCalledTimes(1)
    }
  )

  it.each([false, true])(
    'keeps selected facts through actual adoption with identical local/SSH IDs (reverse=%s)',
    async (reverse) => {
      const modules = await load('win32')
      const store = modules.createStore()
      holder.store = store
      store.setState(
        launchWorkspaceState(
          {
            kind: 'repo',
            path: 'C:\\same',
            projectRuntime: { kind: 'wsl', distro: 'ProjectDistro' }
          },
          {
            ...getDefaultSettings('/home/alice'),
            localWindowsRuntimeDefault: { kind: 'wsl', distro: 'OtherDistro' },
            terminalWindowsShell: 'powershell.exe'
          }
        )
      )
      const initial = store.getState()
      const repo = initial.repos[0]!
      const worktree = initial.worktreesByRepo[repo.id]![0]!
      const twinRepo = { ...repo, executionHostId: 'ssh:other' as const, connectionId: 'other' }
      const twinWorktree = { ...worktree, hostId: 'ssh:other' as const }
      store.setState({
        repos: reverse ? [twinRepo, repo] : [repo, twinRepo],
        worktreesByRepo: {
          [repo.id]: reverse ? [twinWorktree, worktree] : [worktree, twinWorktree]
        },
        activeWorktreeId: 'unrelated',
        activeWorkspaceExecutionHostId: 'ssh:other',
        sshConnectionStates: new Map([['other', { status: 'connected', remotePlatform: 'linux' }]])
      })
      const spawn = vi.fn(async () => ({ id: 'pty-selected' }))
      const kill = vi.fn()
      vi.stubGlobal('window', {
        dispatchEvent: vi.fn(),
        api: { pty: { spawn, write: vi.fn(), kill }, runtime: { call: vi.fn() } }
      })
      const launched = await modules.launch.launchAgentBackgroundSession({
        agent: 'claude',
        worktreeId: worktree.id,
        resolvedTarget: { repo, worktree },
        prompt: 'Selected task'
      })
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: 'C:\\same',
          connectionId: null,
          projectRuntime: expect.objectContaining({
            status: 'resolved',
            runtime: expect.objectContaining({ kind: 'wsl', distro: 'ProjectDistro' })
          })
        })
      )
      const adopted = store
        .getState()
        .unifiedTabsByWorktree[worktree.id]?.find((tab) => tab.entityId === launched?.tabId)
      expect(adopted?.executionHostId).toBe('local')
      expect(
        store.getState().tabsByWorktree[worktree.id]?.find((tab) => tab.id === launched?.tabId)
          ?.shellOverride
      ).toBe('wsl.exe')
      expect(store.getState().activeWorktreeId).toBe('unrelated')
      spawn.mockImplementationOnce(async () => {
        store.setState({ repos: [twinRepo], worktreesByRepo: { [repo.id]: [twinWorktree] } })
        return { id: 'pty-disappeared' }
      })
      expect(
        await modules.launch.launchAgentBackgroundSession({
          agent: 'claude',
          worktreeId: worktree.id,
          resolvedTarget: { repo, worktree }
        })
      ).toBeNull()
      expect(kill).toHaveBeenCalledWith('pty-disappeared')
      expect(store.getState().unifiedTabsByWorktree[worktree.id]).toHaveLength(1)
      await expect(
        modules.launch.launchAgentBackgroundSession({
          agent: 'claude',
          worktreeId: worktree.id,
          resolvedTarget: { repo, worktree }
        })
      ).rejects.toThrow()
      expect(spawn).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['ssh:other', 'runtime:server', 'folder'] as const)(
    'publishes the selected remote or registered-folder owner through the actual store (%s)',
    async (kind) => {
      const modules = await load('darwin')
      const store = modules.createStore()
      holder.store = store
      store.setState(
        launchWorkspaceState({ kind: 'repo', path: '/same' }, getDefaultSettings('/home/alice'))
      )
      const initial = store.getState()
      const baseRepo = initial.repos[0]!
      const baseWorktree = initial.worktreesByRepo[baseRepo.id]![0]!
      const hostId = kind === 'folder' ? 'local' : kind
      const repo = {
        ...baseRepo,
        executionHostId: hostId,
        kind: kind === 'folder' ? ('folder' as const) : ('git' as const),
        connectionId: kind === 'ssh:other' ? 'other' : null
      }
      const worktree = { ...baseWorktree, hostId }
      store.setState({
        repos: [baseRepo, repo].filter((_, index) => kind !== 'folder' || index === 1),
        worktreesByRepo: { [repo.id]: kind === 'folder' ? [worktree] : [baseWorktree, worktree] },
        activeWorktreeId: 'unrelated',
        sshConnectionStates: new Map([['other', { status: 'connected', remotePlatform: 'linux' }]]),
        runtimeStatusByEnvironmentId: new Map([
          [
            'server',
            {
              checkedAt: 1,
              status: {
                runtimeId: 'server',
                rendererGraphEpoch: 0,
                graphStatus: 'ready',
                authoritativeWindowId: null,
                liveTabCount: 0,
                liveLeafCount: 0,
                hostPlatform: 'linux'
              }
            }
          ]
        ])
      })
      const remote = vi
        .spyOn(modules.remoteCreate, 'createRuntimeAgentBackgroundTerminal')
        .mockResolvedValue({
          terminal: { handle: 'term_server', worktreeId: worktree.id, title: null }
        })
      const stream = vi
        .spyOn(modules.remoteStream, 'subscribeToRuntimeTerminalData')
        .mockResolvedValue(() => {})
      const spawn = vi.fn(async () => ({
        id: kind === 'ssh:other' ? 'ssh:other@@pty-1' : 'pty-folder'
      }))
      vi.stubGlobal('window', {
        dispatchEvent: vi.fn(),
        api: { pty: { spawn, write: vi.fn(), kill: vi.fn() }, runtime: { call: vi.fn() } }
      })
      try {
        const launched = await modules.launch.launchAgentBackgroundSession({
          agent: 'claude',
          worktreeId: worktree.id,
          resolvedTarget: { repo, worktree }
        })
        expect(
          store
            .getState()
            .unifiedTabsByWorktree[worktree.id]?.find((tab) => tab.entityId === launched?.tabId)
            ?.executionHostId
        ).toBe(hostId)
        if (kind === 'runtime:server') {
          expect(remote).toHaveBeenCalledWith(
            expect.objectContaining({ environmentId: 'server', worktreeId: worktree.id })
          )
          expect(spawn).not.toHaveBeenCalled()
          launched?.releaseRuntimeObservers()
        } else {
          expect(spawn).toHaveBeenCalledWith(
            expect.objectContaining({
              cwd: '/same',
              connectionId: kind === 'ssh:other' ? 'other' : null
            })
          )
          expect(remote).not.toHaveBeenCalled()
        }
      } finally {
        remote.mockRestore()
        stream.mockRestore()
      }
    }
  )

  it.each(AUTOMATION_LAUNCH_CASES)('$name', async (c) => {
    const { spawn, phone } = await runAutomation(c)
    expect(withFixedIds(spawn.mock.calls[0]?.[0])).toEqual(automationSpawnRequest(c))
    expect(
      phone.map(({ tabs }) =>
        tabs.map((tab) => ({
          title: tab.title,
          launchAgent: recordOf(tab).launchAgent,
          isActive: tab.isActive
        }))
      )
    ).toEqual([[automationPhoneTab(c)]])
  })
})

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? { ...value } : {}
}
