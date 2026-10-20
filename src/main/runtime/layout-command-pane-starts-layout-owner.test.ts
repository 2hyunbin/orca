// Layout-owner build: a client's startPane and wake start the pane through main's one starter
// after the command is written. The reply never carries the effects, a wake keeps the pane's
// resume record in the pane-owned form, and a failed start shows on the pane and keeps the record.
import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord as SleepingRecord } from '../../shared/agent-session-resume'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService, electronMocks } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  deferred,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`
const PANE = { worktreeId: TEST_WORKTREE_ID, tabId: 'host-tab', leafId: HEADLESS_LEAF_ID }

class StatusRuntime extends OrcaRuntimeService {
  setStartStatus(paneKey: string, status: 'sleeping'): void {
    this.paneStartStatuses?.set(paneKey, { status })
  }
  startStatusOf(paneKey: string) {
    return this.paneStartStatuses?.peek(paneKey) ?? null
  }
}

// A running agent's workspace sleep, which the window's wake relaunched before C1c.
const RECORD: SleepingRecord = {
  paneKey: PANE_KEY,
  tabId: 'host-tab',
  worktreeId: TEST_WORKTREE_ID,
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'provider-session-1' },
  prompt: 'do the thing',
  state: 'working',
  capturedAt: 1,
  updatedAt: 1,
  origin: 'worktree-sleep'
}

async function desktopRuntime(
  opts: { slept?: boolean; session?: ReturnType<typeof makeWorkspaceSessionWithHeadlessTerminal> } = {}
) {
  const session =
    opts.session ??
    makeWorkspaceSessionWithHeadlessTerminal(
      opts.slept ? { sleepingAgentSessionsByPaneKey: { [PANE_KEY]: RECORD } } : {}
    )
  // The tab was launched as the agent its record resumes.
  session.tabsByWorktree[TEST_WORKTREE_ID]![0]!.launchAgent = 'claude'
  const fixture = makeRuntimeStoreWithWorkspaceSession(session)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store implements the runtime store methods these tests reach.
  const runtime = new StatusRuntime(fixture.runtimeStore as never, undefined, {
    getDesktopWindowStatus: () => 'openable'
  })
  const started = deferred<{ id: string }>()
  const spawn = vi.fn((_args: { command?: string; sessionId?: string }) => started.promise)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  // The desktop window is open: before C1c it started this pane itself.
  runtime.attachWindow(TEST_WINDOW_ID)
  runtime.markGraphReady(TEST_WINDOW_ID)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only isDestroyed from the window mock.
  electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false } as never)
  await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
    notifyClients: false,
    clientKind: 'runtime'
  })
  return { runtime, spawn, started, getSession: fixture.getSession, setSession: fixture.setSession }
}

const startPane = { type: 'startPane', workspace: TEST_WORKTREE_ID, tabId: 'host-tab' } as const
const wake = { type: 'wake', workspace: TEST_WORKTREE_ID, tabId: 'host-tab' } as const

describe('a client’s startPane in the layout-owner build', () => {
  it('starts a pane restoring from its terminal once, through main, and replies without effects', async () => {
    const { runtime, spawn, started } = await desktopRuntime()
    runtime.setStartStatus(PANE_KEY, 'sleeping')

    const reply = await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    // The command's start is under way before any other trigger; a CLI send joins it.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    const cliSend = runtime.ensureRestoredPaneStarted(PANE)
    started.resolve({ id: 'persisted-pty' })

    await expect(cliSend).resolves.toBe('persisted-pty')
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'persisted-pty' }))
    // The wire reply is the command's outcome and stream position, byte for byte.
    expect(JSON.stringify(reply)).toBe(
      JSON.stringify({ ok: true, result: {}, frameSeq: reply.frameSeq })
    )
  })

  it('leaves a live pane with no start status alone', async () => {
    const { runtime, spawn } = await desktopRuntime()

    await expect(
      runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    ).resolves.toMatchObject({ ok: true })
    await Promise.resolve()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('shows a failed start on the pane', async () => {
    const { runtime, started } = await desktopRuntime()
    runtime.setStartStatus(PANE_KEY, 'sleeping')

    await runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    started.reject(new Error('spawn exploded'))

    await vi.waitFor(() =>
      expect(runtime.startStatusOf(PANE_KEY)).toMatchObject({ status: 'failed' })
    )
  })
})

describe('a client’s wake of a slept pane in the layout-owner build', () => {
  it('resumes its agent through main and keeps the record pane-owned, so a host crash resumes again', async () => {
    const { runtime, spawn, started, getSession } = await desktopRuntime({ slept: true })

    const reply = await runtime.applyLayoutCommand({ ...wake, paneKeys: [PANE_KEY] })
    expect(reply).toMatchObject({ ok: true, result: { woken: [PANE_KEY] } })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    const command = spawn.mock.calls[0]![0].command ?? ''
    expect(command).toContain('--resume')
    expect(command).toContain('provider-session-1')
    started.resolve({ id: 'persisted-pty' })
    await vi.waitFor(() => expect(runtime.isRestoredPaneBoundTo(PANE, 'persisted-pty')).toBe(true))
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
      state: 'done',
      restoreOnTabOpenOnly: true
    })

    // The host crashes: its terminal is gone, and a new runtime loads the same profile.
    const crashed = getSession()
    const restarted = await desktopRuntime({ session: crashed })
    restarted.runtime.setStartStatus(PANE_KEY, 'sleeping')
    await restarted.runtime.applyLayoutCommand({ ...startPane, paneKey: PANE_KEY })
    await vi.waitFor(() => expect(restarted.spawn).toHaveBeenCalled())
    expect(restarted.spawn.mock.calls[0]![0].command ?? '').toContain('provider-session-1')
  })

  it('keeps the record when the start fails', async () => {
    const { runtime, spawn, started, getSession } = await desktopRuntime({ slept: true })

    await runtime.applyLayoutCommand({ ...wake, paneKeys: [PANE_KEY] })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    started.reject(new Error('spawn exploded'))

    await vi.waitFor(() =>
      expect(runtime.startStatusOf(PANE_KEY)).toMatchObject({ status: 'failed' })
    )
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeDefined()
  })

  it('starts once for a second wake while the first is starting', async () => {
    const { runtime, spawn, started } = await desktopRuntime({ slept: true })

    await runtime.applyLayoutCommand({ ...wake, paneKeys: [PANE_KEY] })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    await runtime.applyLayoutCommand({ ...wake, paneKeys: [PANE_KEY] })
    started.resolve({ id: 'persisted-pty' })

    await vi.waitFor(() => expect(runtime.isRestoredPaneBoundTo(PANE, 'persisted-pty')).toBe(true))
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('starts nothing for a record-only wake', async () => {
    const { runtime, spawn, getSession } = await desktopRuntime({ slept: true })

    await runtime.applyLayoutCommand({ ...wake, paneKeys: [PANE_KEY], recordOnly: true })
    await Promise.resolve()

    expect(spawn).not.toHaveBeenCalled()
    expect(getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toBeUndefined()
  })
})
