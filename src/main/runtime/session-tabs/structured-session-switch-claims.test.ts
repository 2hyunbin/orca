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
import { setAgentSessionRecordTerminalSwitch } from '../agent-session-record-terminal-switch'
import { routedTerminalSwitchOwners } from '../../providers/terminal-switch-owners'
import { seedResumeLaunchIdentity } from '../../ipc/pty/pane/resume-launch-identity'
import { isLaterSwitchHostBoot, readSwitchHostBoot } from './structured-session-switch-boot'
import type { AgentProcessVerdict } from '../../../shared/agent-process-presence'
import type { SwitchClaim } from './structured-session-switch-claims'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))
vi.mock('../../agent-hooks/managed-hook-owner-identity', () => ({
  readBootIdentity: async () => boot
}))
vi.mock('../../ipc/pty/pane/resume-launch-identity', () => ({ seedResumeLaunchIdentity: vi.fn() }))
vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runProcess: vi.fn(async () => ({
    code: 0,
    stdout: `    BootId    REG_DWORD    ${boot ?? ''}\r\n`
  }))
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
let boot: string | undefined = '0x1'
/** The chat records' saved switch descriptors, keyed by chat session id. */
let saved: Map<string, TerminalSwitchDescriptor>

const chatStart = () => runtime.assertStructuredAdoptionTerminalWritersExited('codex', C)
const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => 'admitted',
    (error: { refusal?: { details?: { reason?: string } } }) => error.refusal?.details?.reason
  )
const session = (facts: Partial<Session>) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owner reads only these session facts.
  ({ shellReady: { isGatingWrites: false }, ...facts }) as Session
const live = () => session({ isAlive: true, sessionId: 'pty-1', incarnationId: 'i1', pid: 4242 })

beforeEach(() => {
  shellAlone = true
  ownerReachable = true
  boot = '0x1'
  saved = new Map()
  host = new TerminalHostSwitches()
  runtime = new OrcaRuntimeService()
  runtime.registerPty('pty-1', 'wt-1', null, { tabId: 'tab-1', leafId: LEAF, incarnationId: 'i1' })
  const reach = {
    terminalSwitches: {
      owner: async () => host.owner,
      observe: async (generation: string, fence: boolean) => {
        if (!ownerReachable) {
          throw new Error('terminal_switch_owner_unreachable')
        }
        return [host.observe(generation, fence)]
      }
    }
  }
  // The production routing: an unreachable owner must stay unreachable through it.
  const terminalSwitches = routedTerminalSwitchOwners(
    () => reach,
    () => [reach, {}]
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the switch reads only its owner contract.
  runtime.setPtyController({ terminalSwitches } as never)
  vi.spyOn(runtime, 'openAgentSessionRecordStore').mockResolvedValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the switch reads records and writes descriptors only.
    {
      listRecords: () =>
        [...saved].map(([sessionId, terminalSwitch]) => ({ sessionId, terminalSwitch })),
      setTerminalSwitch: async (sessionId: string, write: TerminalSwitchWrite) => {
        const current = saved.get(sessionId)
        const record = {
          ...codexChatHolding(sessionId, [C]),
          ...(current ? { terminalSwitch: current } : {})
        }
        // The journal store freezes what it commits.
        const next = Object.freeze(setAgentSessionRecordTerminalSwitch(record, write, 0))
        Object.freeze(next.terminalSwitch?.processes)
        if (next.terminalSwitch) {
          saved.set(sessionId, next.terminalSwitch)
        } else {
          saved.delete(sessionId)
        }
        return next
      }
    } as never
  )
  vi.spyOn(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census's one process-table read, replaced by the pane's modeled state.
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

    const shell = live()
    host.bind(claim.generation, shell)
    // Bound with no agent recorded: only the owner's end releases it.
    expect(await reason(chatStart())).toBe('conversationHeldElsewhere')
    expect(saved.get('chat-1')).toMatchObject({ ptyId: 'pty-1', incarnationId: 'i1', shell: SHELL })
    runtime['noteSwitchStartProcess']('pty-1', { agent: 'codex', id: C }, AGENT)
    // The shell exiting is not its detached agent exiting.
    Object.assign(shell, { isAlive: false })
    expect(await reason(chatStart())).toBe('conversationHeldElsewhere')
    vi.mocked(switchStartProcessVerdict).mockResolvedValue('exited')
    expect(await reason(chatStart())).toBe('admitted')
    expect(saved.has('chat-1')).toBe(false)
  })

  it('releases on a proved agent exit with that exact shell alone, keeping the shell', async () => {
    const claim = await acceptedSwitch()
    host.begin(claim.generation, host.owner)
    host.bind(claim.generation, live())
    expect(await reason(chatStart())).toBe('conversationHeldElsewhere')
    runtime['noteSwitchStartProcess']('pty-1', { agent: 'codex', id: C }, AGENT)
    vi.mocked(switchStartProcessVerdict).mockResolvedValue('exited')
    shellAlone = false
    expect(await reason(chatStart())).toBe('conversationHeldElsewhere')
    shellAlone = true
    expect(await reason(chatStart())).toBe('admitted')
  })

  it('never lets a retired switch’s late evidence replace the next one', async () => {
    const a = await acceptedSwitch()
    expect(await reason(chatStart())).toBe('admitted')
    const b = await acceptedSwitch()
    a.processes.push(AGENT)
    expect(await runtime.saveSwitchClaim(a)).toBe(false)
    expect(saved.get('chat-1')?.generation).toBe(b.generation)
  })

  it('fences a saved start no terminal took, so it can never start later', async () => {
    const claim = await acceptedSwitch()
    expect(await reason(chatStart())).toBe('admitted')
    expect(() => host.begin(claim.generation, host.owner)).toThrow(
      'terminal_switch_generation_refused'
    )
  })

  it('survives a restart: an unreachable owner holds; a lost one yields only to proof', async () => {
    const sameBoot = await readSwitchHostBoot()
    const lost = (extra: Partial<TerminalSwitchDescriptor>) =>
      saved.set('chat-1', {
        generation: 'g-old',
        agent: 'codex',
        providerSessionId: C,
        owner: 'daemon:gone',
        paneKey: PANE,
        processes: [],
        boot: sameBoot,
        ...extra
      })
    lost({ ptyId: 'pty-1', incarnationId: 'i1', shell: SHELL, processes: [AGENT] })
    ownerReachable = false
    vi.mocked(switchStartProcessVerdict).mockResolvedValue('exited')
    expect(await reason(chatStart())).toBe('conversationHeldElsewhere')
    ownerReachable = true
    vi.mocked(switchStartProcessVerdict).mockResolvedValue('live')
    expect(await reason(chatStart())).toBe('conversationHeldElsewhere')
    vi.mocked(switchStartProcessVerdict).mockResolvedValue('exited')
    expect(await reason(chatStart())).toBe('admitted')

    // A crash before any identity was learned stays held until an OS boot id changes; no id
    // (Windows) never proves a reboot, however far the clock moves.
    lost({})
    runtime['switchClaimsLoaded'] = null
    boot = undefined
    expect(await reason(chatStart())).toBe('conversationHeldElsewhere')
    boot = '0x2'
    expect(await reason(chatStart())).toBe('admitted')
    expect(saved.has('chat-1')).toBe(false)
  })

  it('proves a later boot only from a boot id or an uptime drop, never the wall clock', async () => {
    const onPlatform = (platform: string) =>
      Object.defineProperty(process, 'platform', { value: platform })
    const real = process.platform
    expect(isLaterSwitchHostBoot('a@100', 'a@1')).toBe(false)
    expect(isLaterSwitchHostBoot('a@1', 'b@100')).toBe(true)
    onPlatform('win32')
    boot = '0x1A'
    expect(await readSwitchHostBoot()).toMatch(/^win:0x1a@/)
    expect(isLaterSwitchHostBoot('@100', '@5')).toBe(true)
    expect(isLaterSwitchHostBoot('@100', '@500')).toBe(false)
    // macOS derives uptime from the wall clock, so only its boot id counts there.
    onPlatform('darwin')
    expect(isLaterSwitchHostBoot('@100', '@5')).toBe(false)
    onPlatform(real)
  })

  it('rebuilds a reattached switch terminal’s stamp from its owner, never onto a replacement', async () => {
    const claim = await acceptedSwitch()
    host.begin(claim.generation, host.owner)
    host.bind(claim.generation, live())
    vi.mocked(seedResumeLaunchIdentity).mockClear()
    const reattach = (incarnationId: string) =>
      runtime.registerPty('pty-1', 'wt-1', null, {
        tabId: 'tab-1',
        leafId: LEAF,
        incarnationId,
        providerReattachLaunchIdentity: { incarnationId, launchAgent: 'codex' }
      })
    // Replaced before the owner's answer lands: nothing is stamped onto i2.
    reattach('i1')
    runtime.registerPty('pty-1', 'wt-1', null, {
      tabId: 'tab-1',
      leafId: LEAF,
      incarnationId: 'i2'
    })
    await vi.waitFor(() => expect(saved.get('chat-1')?.ptyId).toBe('pty-1'))
    expect(seedResumeLaunchIdentity).not.toHaveBeenCalled()
    reattach('i1')
    await vi.waitFor(() => expect(seedResumeLaunchIdentity).toHaveBeenCalledOnce())
    expect(seedResumeLaunchIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: PANE,
        resumeProviderSession: { key: 'session_id', id: C },
        execution: { ptyId: 'pty-1', incarnationId: 'i1' }
      })
    )
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
