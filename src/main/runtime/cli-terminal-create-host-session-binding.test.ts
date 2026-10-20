/** A host-initiated create has no renderer session writer, so only its own
 *  durable binding and runtime ownership keep graph sync from pruning the tab
 *  out from under a live agent — including when a window is attached. */
import { describe, expect, it, vi } from 'vitest'
import './rpc/unused-default-rpc-methods.test-fixture'
import {
  startDesktopMultiplexSubscribe,
  sendDesktopMultiplexSubscribe
} from './rpc/terminal-multiplex-test-harness'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => ({ isDestroyed: () => false })) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function createRuntimeWithAttachedWindow(): {
  runtime: OrcaRuntimeService
  spawn: ReturnType<typeof vi.fn>
} {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(
    runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
    },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockResolvedValue({
    id: 'repo-1::/tmp/wt-cli',
    path: '/tmp/wt-cli',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  const spawn = vi.fn().mockResolvedValue({ id: 'repo-1::/tmp/wt-cli@@a1b2c3d4' })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  } as never)
  runtime.attachWindow(1)
  return { runtime, spawn }
}

describe('host-initiated terminal creation under an attached window', () => {
  it('persists the host session binding at spawn', async () => {
    const { runtime, spawn } = createRuntimeWithAttachedWindow()

    await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {})

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ persistHostSessionBinding: true }))
  })

  it('spawns hidden so main answers startup queries before any pane mounts', async () => {
    const { runtime, spawn } = createRuntimeWithAttachedWindow()

    await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {})

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ initiallyHidden: true }))
  })

  it('marks the spawned PTY runtime-session-owned', async () => {
    const { runtime } = createRuntimeWithAttachedWindow()

    await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {})

    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { runtimeSessionOwned: boolean; connected: boolean }>
      }
    ).ptysById.get('repo-1::/tmp/wt-cli@@a1b2c3d4')
    expect(pty?.connected).toBe(true)
    expect(pty?.runtimeSessionOwned).toBe(true)
  })
})

it.each(['refused', 'adopted', 'fresh-unavailable'] as const)(
  'publishes the effective %s terminal rather than the requested saved recipe',
  async (kind) => {
    const { runtime, spawn } = createRuntimeWithAttachedWindow()
    const config = { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
    spawn.mockResolvedValue({
      id: 'effective-pty',
      ...(kind === 'adopted'
        ? { isReattach: true, launchAgent: 'codex', launchConfig: config }
        : {}),
      ...(kind === 'refused'
        ? {
            agentResumeRefused: 'chat-home',
            agentResumeUnavailable: true,
            savedResumeDecision: {
              agent: 'claude',
              providerSession: { key: 'session_id', id: 'C' },
              verdict: 'chat-home'
            }
          }
        : {}),
      ...(kind === 'fresh-unavailable'
        ? {
            agentResumeUnavailable: true,
            launchAgent: 'codex',
            launchConfig: config,
            launchToken: 'actual-fresh-token'
          }
        : {})
    })
    const result = await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {
      launchAgent: 'claude',
      title: 'Rejected C',
      resumeOrigin: 'saved',
      resumeProviderSession: { key: 'session_id', id: 'C' },
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} }
    })
    expect(result.agentResumeRefused).toBe(kind === 'refused' ? 'chat-home' : undefined)
    expect(result.launchAgent).toBe(kind === 'refused' ? undefined : 'codex')
    expect(result.launchConfig).toEqual(kind === 'refused' ? undefined : config)
    if (kind === 'refused') {
      expect(result.title).not.toBe('Rejected C')
    }
    if (kind === 'fresh-unavailable') {
      expect(result.launchToken).toBe('actual-fresh-token')
    }
  }
)

it.each(['unchanged', 'hook', 'config', 'incarnation', 'handle'] as const)(
  'samples the actual created PTY after snapshot awaits and revalidates %s on reconnect',
  async (change) => {
    const { runtime, spawn } = createRuntimeWithAttachedWindow()
    const providerSession = { key: 'session_id' as const, id: 'C' }
    spawn.mockResolvedValue({
      id: 'effective-pty',
      incarnationId: 'i1',
      agentResumeUnavailable: true,
      agentResumeRefused: 'chat-home',
      savedResumeDecision: { agent: 'claude', providerSession, verdict: 'chat-home' }
    })
    const terminal = await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {
      tabId: 'saved-tab',
      leafId: '11111111-1111-4111-8111-111111111111',
      launchAgent: 'claude',
      resumeOrigin: 'saved',
      resumeProviderSession: providerSession
    })
    let snapshotStarted = false
    let finishSnapshot = () => {}
    let handle = terminal.handle
    const harness = startDesktopMultiplexSubscribe({
      resolveLiveLeafForHandle: () => runtime.resolveLiveLeafForHandle(handle),
      getPtyExecutionHostMetadata: runtime.getPtyExecutionHostMetadata.bind(runtime),
      getTerminalLaunchResult: runtime.getTerminalLaunchResult.bind(runtime),
      serializeTerminalBuffer: () =>
        new Promise((resolve) => {
          snapshotStarted = true
          finishSnapshot = () => resolve({ data: 'shell$ ', cols: 80, rows: 24 })
        })
    })
    try {
      await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
      sendDesktopMultiplexSubscribe(harness.handlers)
      await vi.waitFor(() => expect(snapshotStarted).toBe(true))
      if (change === 'hook') {
        runtime.recordCliWriterConversation({
          paneKey: 'saved-tab:11111111-1111-4111-8111-111111111111',
          connectionId: null,
          receivedAt: 1,
          stateStartedAt: 1,
          providerSession,
          payload: { state: 'done', prompt: '', agentType: 'claude' },
          agentPresence: {
            agent: 'claude',
            process: { pid: 12, platform: 'darwin', startTime: 's' }
          }
        })
      } else if (change === 'config') {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime owns this PTY map; mutate its actual record to model a replacement launch.
        const records = (runtime as unknown as { ptysById: Map<string, RuntimePtyWorktreeRecord> })
          .ptysById
        const pty = records.get('effective-pty')!
        pty.launchConfig = { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
      } else if (change === 'incarnation') {
        runtime.registerPty('effective-pty', 'repo-1::/tmp/wt-cli', null, {
          tabId: 'saved-tab',
          leafId: '11111111-1111-4111-8111-111111111111',
          incarnationId: 'i2'
        })
      } else if (change === 'handle') {
        handle = 'stale-handle'
      }
      finishSnapshot()
      const events = () => harness.messages.map((message) => JSON.parse(message).result)
      const stale = change === 'handle' || change === 'incarnation'
      await vi.waitFor(() =>
        expect(events().some((event) => event?.type === (stale ? 'end' : 'subscribed'))).toBe(true)
      )
      if (stale) {
        expect(events().some((event) => event?.type === 'subscribed')).toBe(false)
      } else {
        const result = events().find((event) => event?.type === 'subscribed').launchResult
        expect(result).toMatchObject({ ptyId: 'effective-pty', incarnationId: 'i1' })
        expect(result.agentResumeRefused).toBe(change === 'unchanged' ? 'chat-home' : undefined)
        harness.messages.splice(0)
        snapshotStarted = false
        sendDesktopMultiplexSubscribe(harness.handlers)
        await vi.waitFor(() => expect(snapshotStarted).toBe(true))
        finishSnapshot()
        await vi.waitFor(() =>
          expect(events().some((event) => event?.type === 'subscribed')).toBe(true)
        )
        expect(events().find((event) => event?.type === 'subscribed').launchResult).toEqual(result)
      }
    } finally {
      harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
      await harness.dispatchPromise
    }
  }
)
