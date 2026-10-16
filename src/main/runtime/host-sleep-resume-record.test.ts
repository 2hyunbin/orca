// A paired client's sleep stops the host's PTYs; the host must keep the session to resume on open.
import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')
const { captureWorktreeSleepResumeRecords } =
  await import('./terminal/stop/worktree-sleep-resume-records')

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`
const HOLDER_PANE_KEY = 'holder-tab:44444444-4444-4444-8444-444444444444'
const SESSION_ID = 'slept-provider-session'

type Verdict = 'exited' | 'unverifiable' | null

function makeRuntime(initialVerdict: Verdict, holderVerdict: Verdict = null) {
  let verdict = initialVerdict
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const live = new Set<string>()
  let spawned = 0
  const spawn = vi.fn(async (_args: unknown) => {
    const id = `host-pty-${++spawned}`
    live.add(id)
    return { id }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook row reads only the fields the sleep capture uses.
  const row = {
    paneKey: PANE_KEY,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: SESSION_ID },
    prompt: 'first prompt',
    state: 'done',
    receivedAt: 1,
    stateStartedAt: 1,
    connectionId: null
  } as AgentStatusIpcPayload
  let rows: AgentStatusIpcPayload[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store implements the runtime store methods these tests reach.
  const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
    getAgentProviderSessionSnapshot: () => rows,
    checkHookAgentPresence: async (paneKey: string) =>
      paneKey === HOLDER_PANE_KEY ? holderVerdict : verdict
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    stopAndWait: async (ptyId: string) => {
      live.delete(ptyId)
      // A PTY's exit clears its hook row, as the host's teardown does.
      rows = []
      return true
    },
    getForegroundProcess: async () => null,
    listProcesses: async () =>
      [...live].map((id) => ({ id, worktreeId: TEST_WORKTREE_ID, cwd: '/tmp', title: 'Claude' }))
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const reportAgent = (): void => {
    rows = [row]
  }
  // The session resumed by hand in another pane whose shell outlived it.
  const reportHolder = (): void => {
    rows = [{ ...row, paneKey: HOLDER_PANE_KEY, tabId: 'holder-tab' }]
  }
  const setVerdict = (next: Verdict): void => {
    verdict = next
  }
  return { runtime, spawn, reportAgent, reportHolder, setVerdict }
}

function userActivate(runtime: InstanceType<typeof OrcaRuntimeService>) {
  return runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
    notifyClients: false,
    navigation: 'caller',
    intent: 'user'
  })
}

function spawnCommand(spawn: ReturnType<typeof vi.fn>, call: number): string {
  const args: unknown = spawn.mock.calls[call]?.[0]
  return typeof args === 'object' && args !== null && 'command' in args
    ? String(args.command ?? '')
    : ''
}

describe('host-driven worktree sleep keeps the slept agent resumable', () => {
  it.each([
    [null, true],
    ['unverifiable', true],
    ['exited', false]
  ] as const)('agent verdict %s at sleep: reopen resumes %s', async (verdict, resumes) => {
    const { runtime, spawn, reportAgent } = makeRuntime(verdict)
    await userActivate(runtime)
    expect(spawn).toHaveBeenCalledOnce()
    reportAgent()

    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    await userActivate(runtime)

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawnCommand(spawn, 1).includes(SESSION_ID)).toBe(resumes)
  })

  it.each([
    ['exited', true],
    ['unverifiable', false]
  ] as const)('another pane holding the session %s: reopen resumes %s', async (holder, resumes) => {
    const { runtime, spawn, reportAgent, reportHolder } = makeRuntime(null, holder)
    await userActivate(runtime)
    reportAgent()
    await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
    reportHolder()

    await userActivate(runtime)

    expect(spawnCommand(spawn, 1).includes(SESSION_ID)).toBe(resumes)
  })

  it.each([
    [null, true],
    ['exited', false]
  ] as const)(
    're-slept before its first hook, verdict %s: reopen resumes %s',
    async (v, resumes) => {
      const { runtime, spawn, reportAgent, setVerdict } = makeRuntime(null)
      await userActivate(runtime)
      reportAgent()
      await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
      await userActivate(runtime)
      // The resumed agent has not reported yet, so the host holds no row for the pane.
      setVerdict(v)
      await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)

      await userActivate(runtime)

      expect(spawn).toHaveBeenCalledTimes(3)
      expect(spawnCommand(spawn, 2).includes(SESSION_ID)).toBe(resumes)
    }
  )

  it.each([
    ['claude', true],
    ['codex', false]
  ] as const)('keeps a %s-launched PTY recipe: %s', async (launchAgent, kept) => {
    const config = { agentCommand: '/opt/claude-custom', agentArgs: '--x', agentEnv: {} }
    const capture = await captureWorktreeSleepResumeRecords({
      worktreeId: TEST_WORKTREE_ID,
      paneKeysByPtyId: new Map([['pty', [PANE_KEY]]]),
      launchByPtyId: new Map([['pty', { agent: launchAgent, config }]]),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the capture reads only these row fields.
      rows: [
        {
          paneKey: PANE_KEY,
          agentType: 'claude',
          providerSession: { key: 'session_id', id: SESSION_ID },
          prompt: '',
          receivedAt: 1
        } as AgentStatusIpcPayload
      ],
      checkAgentPresence: null,
      capturedAt: 2
    })
    expect(capture.get('pty')?.records[0]?.launchConfig).toEqual(kept ? config : undefined)
  })
})
