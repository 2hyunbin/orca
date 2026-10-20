import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../rpc/unused-default-rpc-methods.test-fixture'
import { OrcaRuntimeService } from '../orca-runtime'
import { admitSwitchResumeSpawn } from '../../ipc/pty/host-env/resume-spawn-judgement'
import type { AdmissionRuntime } from '../../ipc/pty/host-env/resume-spawn-judgement'
import { TerminalHostSwitches } from '../../daemon/terminal-host-switches'
import type { Session } from '../../daemon/session'
import { switchStartProcessVerdict } from './structured-session-switch-observation'
import { codexChatHolding } from '../../ai-vault/structured-session-ownership.test-support'
import {
  TERMINAL_SWITCH_GENERATION_ENV,
  type TerminalSwitchDescriptor,
  type TerminalSwitchWrite
} from '../../../shared/terminal-switch'
import type { AgentProcessVerdict } from '../../../shared/agent-process-presence'
import type { SwitchClaim } from './structured-session-switch-claims'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))
vi.mock('./structured-session-switch-observation', () => ({
  readSwitchPaneAgentProcesses: vi.fn(async () => []),
  readSwitchShellProcess: vi.fn(async (pid: number) => ({
    pid,
    platform: 'linux',
    startTime: 's'
  })),
  switchStartProcessVerdict: vi.fn(async (): Promise<AgentProcessVerdict> => 'live')
}))

const C = 'thread-c'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = `tab-1:${LEAF}`
const SHELL = { pid: 4242, platform: 'linux', startTime: 's' } as const
const AGENT = { pid: 999_991, platform: 'linux', startTime: 'started' } as const
let runtime: OrcaRuntimeService
let host: TerminalHostSwitches
let shellAlone: boolean
let ownerReachable: boolean
/** The chat records' saved switch descriptors, keyed by chat session id. */
let saved: Map<string, TerminalSwitchDescriptor>

const chatStart = () => runtime.assertStructuredAdoptionTerminalWritersExited('codex', C)
const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => 'admitted',
    (error: { refusal?: { details?: { reason?: string } } }) => error.refusal?.details?.reason
  )
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owner reads only these four session facts.
const session = (facts: Partial<Session>) => ({ ...facts }) as Session

beforeEach(() => {
  shellAlone = true
  ownerReachable = true
  saved = new Map()
  host = new TerminalHostSwitches()
  runtime = new OrcaRuntimeService()
  runtime.registerPty('pty-1', 'wt-1', null, { tabId: 'tab-1', leafId: LEAF, incarnationId: 'i1' })
  runtime.setPtyController({
    terminalSwitches: {
      owner: async () => host.owner,
      observe: async (generation, fence) => {
        if (!ownerReachable) {
          throw new Error('host unreachable')
        }
        return [host.observe(generation, fence)]
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the switch reads only its owner contract.
  } as never)
  vi.spyOn(runtime, 'openAgentSessionRecordStore').mockResolvedValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the switch reads records and writes descriptors only.
    {
      listRecords: () =>
        [...saved].map(([sessionId, terminalSwitch]) => ({ sessionId, terminalSwitch })),
      setTerminalSwitch: async (sessionId: string, write: TerminalSwitchWrite) => {
        if (!('clear' in write)) {
          saved.set(sessionId, write)
        } else if (saved.get(sessionId)?.generation === write.clear) {
          saved.delete(sessionId)
        }
      }
    } as never
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census's one process-table read, replaced by the pane's modeled state.
  vi.spyOn(
    runtime as never as { cliWriterShellAlone: () => Promise<boolean> },
    'cliWriterShellAlone'
  ).mockImplementation(async () => shellAlone)
  vi.mocked(switchStartProcessVerdict).mockResolvedValue('live')
})

async function acceptedSwitch(): Promise<SwitchClaim> {
  const claim = runtime.registerSwitchClaim('codex', C, 'chat-1', host.owner)
  runtime.acceptSwitchStart(claim.generation, PANE)
  await runtime.saveSwitchClaim(claim)
  return claim
}

describe('a chat → terminal switch start', () => {
  it('is held from the recipe until its owner proves the exact execution over', async () => {
    const claim = runtime.registerSwitchClaim('codex', C, 'chat-1', host.owner)
    expect(await reason(chatStart())).toBe('conversationMovingToTerminal')
    expect(() => runtime.registerSwitchClaim('codex', C, 'chat-1', host.owner)).toThrow(
      'agent_session_conflict'
    )
    expect(runtime.acceptSwitchStart(claim.generation, PANE)).toBe(claim)
    // One pane takes a generation; a retry there joins it.
    expect(runtime.acceptSwitchStart(claim.generation, 'tab-2:other')).toBeNull()
    expect(runtime.acceptSwitchStart(claim.generation, PANE)).toBe(claim)
    await runtime.saveSwitchClaim(claim)
    host.begin(claim.generation, host.owner)
    expect(await reason(chatStart())).toBe('conversationMovingToTerminal')
    expect(() => host.begin(claim.generation, host.owner)).toThrow(
      'terminal_switch_generation_refused'
    )

    const shell = session({ isAlive: true, sessionId: 'pty-1', incarnationId: 'i1', pid: 4242 })
    host.bind(claim.generation, shell)
    // Bound with no agent recorded: only the owner's end releases it.
    expect(await reason(chatStart())).toBe('conversationHeldElsewhere')
    expect(saved.get('chat-1')).toMatchObject({ ptyId: 'pty-1', incarnationId: 'i1', shell: SHELL })
    Object.assign(shell, { isAlive: false })
    expect(await reason(chatStart())).toBe('admitted')
    expect(saved.has('chat-1')).toBe(false)
  })

  it('releases on a proved agent exit with that exact shell alone, keeping the shell', async () => {
    const claim = await acceptedSwitch()
    host.begin(claim.generation, host.owner)
    host.bind(
      claim.generation,
      session({ isAlive: true, sessionId: 'pty-1', incarnationId: 'i1', pid: 4242 })
    )
    expect(await reason(chatStart())).toBe('conversationHeldElsewhere')
    runtime['noteSwitchStartProcess']('pty-1', { agent: 'codex', id: C }, AGENT)
    vi.mocked(switchStartProcessVerdict).mockResolvedValue('exited')
    shellAlone = false
    expect(await reason(chatStart())).toBe('conversationHeldElsewhere')
    shellAlone = true
    expect(await reason(chatStart())).toBe('admitted')
  })

  it('fences a saved start no terminal took, so it can never start later', async () => {
    const claim = await acceptedSwitch()
    expect(await reason(chatStart())).toBe('admitted')
    expect(() => host.begin(claim.generation, host.owner)).toThrow(
      'terminal_switch_generation_refused'
    )
  })

  it('survives a restart: a lost owner never speaks, only the recorded execution can end it', async () => {
    saved.set('chat-1', {
      generation: 'g-old',
      agent: 'codex',
      providerSessionId: C,
      owner: 'daemon:gone',
      paneKey: PANE,
      ptyId: 'pty-1',
      incarnationId: 'i1',
      shell: SHELL,
      processes: [AGENT]
    })
    ownerReachable = false
    vi.mocked(switchStartProcessVerdict).mockResolvedValue('exited')
    expect(await reason(chatStart())).toBe('conversationHeldElsewhere')
    ownerReachable = true
    vi.mocked(switchStartProcessVerdict).mockResolvedValue('live')
    expect(await reason(chatStart())).toBe('conversationHeldElsewhere')
    vi.mocked(switchStartProcessVerdict).mockResolvedValue('exited')
    expect(await reason(chatStart())).toBe('admitted')
    expect(saved.has('chat-1')).toBe(false)
  })
})

describe('a switch spawn', () => {
  const args = (generation = 'g1') => ({
    launchAgent: 'codex' as const,
    resumeProviderSession: { key: 'session_id' as const, id: C },
    resumeOrigin: 'switch',
    env: { [TERMINAL_SWITCH_GENERATION_ENV]: generation, KEEP: '1' }
  })
  const claim: SwitchClaim = {
    generation: 'g1',
    agent: 'codex',
    providerSessionId: C,
    owner: 'daemon:o',
    paneKey: PANE,
    processes: [],
    chatSessionId: 'chat-1',
    at: 0,
    accepted: true
  }
  const admission = (writing: boolean, savedOk = true) =>
    ({
      acceptSwitchStart: vi.fn(() => claim),
      saveSwitchClaim: vi.fn(async () => savedOk),
      dispatchSwitchStart: vi.fn(() => ({ switchGeneration: 'g1', switchOwner: 'daemon:o' })),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a switch spawn reads only the store's records and tab index.
      openAgentSessionRecordStore: vi.fn(
        async () =>
          ({
            listRecords: () => (writing ? [codexChatHolding('chat-1', [C])] : []),
            getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [] })
          }) as never
      )
    }) satisfies AdmissionRuntime

  it('hands the owner its generation only once the start is saved and the chat is quiet', async () => {
    const quiet = admission(false)
    const spawnArgs = args()
    const options: { env?: Record<string, string>; switchGeneration?: string } = {
      env: { ...spawnArgs.env }
    }
    expect(
      await admitSwitchResumeSpawn(quiet, spawnArgs, null, { paneKey: PANE, options })
    ).toMatchObject({ verdict: 'admitted' })
    expect(quiet.acceptSwitchStart).toHaveBeenCalledWith('g1', PANE)
    expect(options).toEqual({ env: { KEEP: '1' }, switchGeneration: 'g1', switchOwner: 'daemon:o' })
    expect(spawnArgs.env).toEqual({ KEEP: '1' })

    const writing = admission(true)
    const refused = admitSwitchResumeSpawn(writing, args(), null, { paneKey: PANE, options: {} })
    // Accepted before the first await, so a chat start's census sees it.
    expect(writing.acceptSwitchStart).toHaveBeenCalledOnce()
    expect(await refused).toMatchObject({ verdict: 'chat-writing' })
    expect(writing.dispatchSwitchStart).not.toHaveBeenCalled()

    const unsaved = admission(false, false)
    expect(
      await admitSwitchResumeSpawn(unsaved, args(), null, { paneKey: PANE, options: {} })
    ).toMatchObject({ verdict: 'unverifiable' })
    expect(unsaved.dispatchSwitchStart).not.toHaveBeenCalled()
  })

  it('refuses where it cannot judge the pane, and a switch without its conversation', async () => {
    const quiet = admission(false)
    const spawn = { paneKey: PANE, options: {} }
    expect(
      await admitSwitchResumeSpawn(quiet, { ...args(), connectionId: 'ssh' }, null, spawn)
    ).toMatchObject({ verdict: 'unverifiable' })
    expect(await admitSwitchResumeSpawn(quiet, args(), 'Ubuntu', spawn)).toMatchObject({
      verdict: 'unverifiable'
    })
    await expect(
      admitSwitchResumeSpawn(quiet, { ...args(), resumeProviderSession: undefined }, null, spawn)
    ).rejects.toThrow('switch_start_missing_conversation')
    expect(quiet.acceptSwitchStart).not.toHaveBeenCalled()
  })
})
