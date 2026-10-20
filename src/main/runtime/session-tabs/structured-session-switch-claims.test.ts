import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../rpc/unused-default-rpc-methods.test-fixture'
import { OrcaRuntimeService } from '../orca-runtime'
import { admitSwitchResumeSpawn } from '../../ipc/pty/host-env/resume-spawn-judgement'
import { switchStartProcessVerdict } from './structured-session-switch-observation'
import type { AgentProcessVerdict } from '../../../shared/agent-process-presence'
import { codexChatHolding } from '../../ai-vault/structured-session-ownership.test-support'
import type { AdmissionRuntime } from '../../ipc/pty/host-env/resume-spawn-judgement'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))
vi.mock('./structured-session-switch-observation', () => ({
  readSwitchPaneAgentProcesses: vi.fn(async () => []),
  switchStartProcessVerdict: vi.fn(async (): Promise<AgentProcessVerdict> => 'live')
}))

const C = 'thread-c'
const LEAF = '11111111-1111-4111-8111-111111111111'
const AGENT = { pid: 999_991, platform: process.platform, startTime: 'started' } as const
let runtime: OrcaRuntimeService
let shellAlone: boolean

const chatStart = () => runtime.assertStructuredAdoptionTerminalWritersExited('codex', C)
const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => 'admitted',
    (error: { refusal?: { details?: { reason?: string } } }) => error.refusal?.details?.reason
  )
function hook(process?: typeof AGENT): void {
  runtime.recordCliWriterConversation({
    paneKey: `tab-1:${LEAF}`,
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    providerSession: { key: 'session_id', id: C },
    payload: { state: 'done', prompt: '', agentType: 'codex' },
    ...(process ? { agentPresence: { agent: 'codex', process } } : {})
  })
}

beforeEach(() => {
  shellAlone = true
  runtime = new OrcaRuntimeService()
  runtime.registerPty('pty-1', 'wt-1', null, { tabId: 'tab-1', leafId: LEAF, incarnationId: 'i1' })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census's one process-table read, replaced by the pane's modeled state.
  vi.spyOn(
    runtime as never as { cliWriterShellAlone: () => Promise<boolean> },
    'cliWriterShellAlone'
  ).mockImplementation(async () => shellAlone)
  vi.mocked(switchStartProcessVerdict).mockResolvedValue('live')
})
afterEach(() => vi.useRealTimers())

describe('the switch claim', () => {
  it('refuses a chat start until a spawn takes it; an accepted start never lapses', async () => {
    vi.useFakeTimers()
    runtime.registerSwitchClaim('codex', C)
    expect(await reason(chatStart())).toBe('conversationMovingToTerminal')
    vi.advanceTimersByTime(61_000)
    expect(await reason(chatStart())).toBe('admitted')

    runtime.registerSwitchClaim('codex', C)
    runtime.acceptSwitchStart('codex', C)
    // A spawn slower than the window keeps refusing until it settles.
    vi.advanceTimersByTime(120_000)
    expect(await reason(chatStart())).toBe('conversationMovingToTerminal')
  })

  it('binds to the switch terminal, ignores identity-only replays, and ends on a proven exit', async () => {
    const claim = runtime.acceptSwitchStart('codex', C)
    runtime.settleSwitchStart(claim, 'pty-1')
    expect(await reason(chatStart())).toBe('conversationHeldElsewhere')
    // The launch identity names the conversation without proving a start or an exit.
    hook()
    expect(await reason(chatStart())).toBe('conversationHeldElsewhere')
    hook(AGENT)
    expect(await reason(chatStart())).toBe('conversationHeldElsewhere')
    vi.mocked(switchStartProcessVerdict).mockResolvedValue('exited')
    shellAlone = false
    expect(await reason(chatStart())).toBe('conversationHeldElsewhere')
    shellAlone = true
    expect(await reason(chatStart())).toBe('admitted')
  })

  it('refuses a second switch of the conversation while the first terminal may hold it', () => {
    const first = runtime.acceptSwitchStart('codex', C)
    runtime.settleSwitchStart(first, 'pty-1')
    expect(() => runtime.registerSwitchClaim('codex', C)).toThrow('agent_session_conflict')
  })
})

describe('a switch spawn', () => {
  const args = {
    launchAgent: 'codex' as const,
    resumeProviderSession: { key: 'session_id' as const, id: C },
    resumeOrigin: 'switch'
  }
  const admission = (writing: boolean) =>
    ({
      acceptSwitchStart: vi.fn(() => ({ agent: 'codex', id: C, at: 0, accepted: true })),
      settleSwitchStart: vi.fn(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a switch spawn reads only the store's records and tab index.
      openAgentSessionRecordStore: vi.fn(
        async () =>
          ({
            listRecords: () => (writing ? [codexChatHolding('chat-1', [C])] : []),
            getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [] })
          }) as never
      )
    }) satisfies AdmissionRuntime

  it('claims before reading the chat, and a writing chat refuses it into a plain shell', async () => {
    const quiet = admission(false)
    expect(await admitSwitchResumeSpawn(quiet, args, null)).toMatchObject({
      verdict: 'admitted',
      switchClaim: { id: C }
    })
    const writing = admission(true)
    const refused = admitSwitchResumeSpawn(writing, args, null)
    expect(writing.acceptSwitchStart.mock.invocationCallOrder[0]).toBeLessThan(
      writing.openAgentSessionRecordStore.mock.invocationCallOrder[0]!
    )
    expect(await refused).toMatchObject({ verdict: 'chat-writing' })
    expect(writing.settleSwitchStart).toHaveBeenCalledWith(expect.anything(), null)
  })

  it('refuses where it cannot judge the pane, and a switch without its conversation', async () => {
    const quiet = admission(false)
    expect(
      await admitSwitchResumeSpawn(quiet, { ...args, connectionId: 'ssh' }, null)
    ).toMatchObject({ verdict: 'unverifiable' })
    expect(await admitSwitchResumeSpawn(quiet, args, 'Ubuntu')).toMatchObject({
      verdict: 'unverifiable'
    })
    await expect(
      admitSwitchResumeSpawn(quiet, { ...args, resumeProviderSession: undefined }, null)
    ).rejects.toThrow('switch_start_missing_conversation')
  })
})
