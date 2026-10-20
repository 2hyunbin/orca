/** A host-initiated create has no renderer session writer, so only its own
 *  durable binding and runtime ownership keep graph sync from pruning the tab
 *  out from under a live agent — including when a window is attached. */
import { describe, expect, it, vi } from 'vitest'
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
