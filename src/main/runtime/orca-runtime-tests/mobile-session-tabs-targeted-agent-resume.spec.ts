import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, electronMocks } from '../orca-runtime-test-mocks.spec'
import type { SleepingAgentSessionRecord } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import type { PtyProcessInfo } from '../../providers/pty-provider-contract'
import { deriveRemoteRuntimeTerminalCreateHandle } from '../remote-runtime-terminal-create-identity'

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`
const SESSION = { key: 'session_id', id: 'provider-session-1' } as const
const MUTATION_ID = '["dev","thread-1","delivery-1"]'
const PANE_OWNED = { origin: 'worktree-sleep', state: 'done', restoreOnTabOpenOnly: true }

// A headless host holding a running agent's workspace-sleep record for the old pane.
function makeSleptWorkspace() {
  const record: SleepingAgentSessionRecord = {
    paneKey: PANE_KEY,
    tabId: 'host-tab',
    worktreeId: TEST_WORKTREE_ID,
    agent: 'claude',
    providerSession: SESSION,
    prompt: 'do the thing',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep',
    launchConfig: { agentArgs: '--permission-mode plan', agentEnv: {} }
  }
  return makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
    })
  )
}

type Fixture = ReturnType<typeof makeSleptWorkspace>

function sessionRow(paneKey: string, receivedAt = 0): AgentStatusIpcPayload {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resume guards read only paneKey, providerSession and the observation clocks.
  return { paneKey, providerSession: SESSION, receivedAt } as never
}

function makeRuntime(
  fixture: Fixture,
  opts: {
    spawn?: () => Promise<{ id: string }>
    rows?: () => AgentStatusIpcPayload[]
    checkHookAgentPresence?: () => Promise<'live' | 'unverifiable' | 'exited' | null>
    listProcesses?: () => Promise<PtyProcessInfo[]>
  } = {}
) {
  const spawn = vi.fn<(args: unknown) => Promise<{ id: string }>>(
    opts.spawn ?? (() => Promise.resolve({ id: 'resumed-pty' }))
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture store implements the runtime store methods these tests reach.
  const runtime = new OrcaRuntimeService(fixture.runtimeStore as never, undefined, {
    getDesktopWindowStatus: () => 'openable',
    ...(opts.rows ? { getAgentProviderSessionSnapshot: opts.rows } : {}),
    ...(opts.checkHookAgentPresence ? { checkHookAgentPresence: opts.checkHookAgentPresence } : {})
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: opts.listProcesses ?? (async () => [])
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  electronMocks.BrowserWindow.fromId.mockReturnValue(null)
  const attachWindow = (webContents?: { send: (...args: unknown[]) => void }): void => {
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)
    electronMocks.BrowserWindow.fromId.mockReturnValue(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime reads only isDestroyed and webContents.send from the window mock.
      { isDestroyed: () => false, ...(webContents ? { webContents } : {}) } as never
    )
  }
  const resume = (
    overrides: {
      captureHostId?: 'local' | `ssh:${string}`
      mutationId?: string
      signal?: AbortSignal
    } = {}
  ) =>
    runtime.resumeAgentSessionInWorkspace(TEST_WORKTREE_ID, {
      agent: 'claude',
      providerSession: SESSION,
      captureHostId: overrides.captureHostId ?? 'local',
      mutationId: overrides.mutationId ?? MUTATION_ID,
      signal: overrides.signal
    })
  const openOldPane = () =>
    runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
      notifyClients: false,
      navigation: 'caller',
      intent: 'user'
    })
  return { runtime, spawn, attachWindow, resume, openOldPane }
}

function spawnedCommands(spawn: ReturnType<typeof vi.fn>): string[] {
  return spawn.mock.calls.map(([args]: unknown[]) =>
    typeof args === 'object' && args !== null && 'command' in args ? String(args.command ?? '') : ''
  )
}

function resumeSpawns(spawn: ReturnType<typeof vi.fn>): number {
  return spawnedCommands(spawn).filter((command) => command.includes('provider-session-1')).length
}

function storedRecord(fixture: Fixture) {
  return fixture.getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]
}

describe('resumeAgentSessionInWorkspace', () => {
  // Review repro, on the runtime-owned path: the spawn started but its reply was lost.
  it('review: retains ownership after an ambiguous create with a running resume', async () => {
    const fixture = makeSleptWorkspace()
    const handle = deriveRemoteRuntimeTerminalCreateHandle(
      'agent-session-resume',
      TEST_WORKTREE_ID,
      MUTATION_ID
    )
    let started = false
    const { spawn, resume, attachWindow } = makeRuntime(fixture, {
      rows: () => [],
      // The host starts the agent, but its spawn reply is lost.
      spawn: () => {
        started = true
        return Promise.reject(new Error('spawn reply lost'))
      },
      listProcesses: async () =>
        started
          ? [
              {
                id: 'resumed-pty',
                cwd: '',
                title: 'claude',
                terminalHandle: handle,
                worktreeId: TEST_WORKTREE_ID
              }
            ]
          : []
    })
    const record = storedRecord(fixture)
    if (record) {
      record.state = 'done'
    }
    const send = vi.fn()
    attachWindow({ send })

    await expect(resume()).resolves.toEqual({ ok: false, reason: 'create_failed' })
    await expect(resume({ mutationId: 'another-delivery' })).resolves.toEqual({
      ok: false,
      reason: 'held_elsewhere'
    })
    // Why: the same request's retry reconciles the pane it may have started instead of spawning.
    await expect(resume()).resolves.toMatchObject({ ok: true, ptyId: 'resumed-pty' })
    expect(spawn).toHaveBeenCalledOnce()
    // Why: with a window attached the spawn still carries the runtime the command was quoted for.
    expect(spawn.mock.calls[0]?.[0]).toHaveProperty('launchRuntime')
    expect(send).not.toHaveBeenCalledWith('terminal:requestTabCreate', expect.anything())
  })

  it('review: rechecks hook ownership when another resume settles during pane preflight', async () => {
    const fixture = makeSleptWorkspace()
    let rows: AgentStatusIpcPayload[] = []
    const { runtime, spawn, resume, openOldPane } = makeRuntime(fixture, {
      rows: () => rows,
      checkHookAgentPresence: async () => 'live'
    })
    const resolveWorkspace: unknown = Reflect.get(runtime, 'resolveTerminalWorkspaceLaunchScope')
    if (typeof resolveWorkspace !== 'function') {
      throw new Error('missing resolver')
    }
    let first = true
    Object.assign(runtime, {
      resolveTerminalWorkspaceLaunchScope: async (...args: unknown[]) => {
        if (first) {
          first = false
          // Why no throw on refusal: the pane's earlier claim now refuses this resume outright.
          const result = await resume()
          if (result.ok) {
            rows = [sessionRow(result.paneKey, Date.now() + 1)]
          }
        }
        return Reflect.apply(resolveWorkspace, runtime, args)
      }
    })
    await openOldPane()
    expect(resumeSpawns(spawn)).toBe(1)
  })

  it('resumes the conversation in a fresh pane with its recorded flags and returns the binding', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, resume } = makeRuntime(fixture)

    const result = await resume()

    expect(result).toMatchObject({ ok: true, ptyId: 'resumed-pty' })
    expect(result.ok && result.paneKey).not.toBe(PANE_KEY)
    expect(spawn).toHaveBeenCalledOnce()
    const [command] = spawnedCommands(spawn)
    expect(command).toContain('--resume')
    expect(command).toContain('provider-session-1')
    expect(command).toMatch(/--permission-mode'? '?plan/)
    // Why: the explicit resume command must spawn in the runtime it was quoted for (Windows/WSL).
    expect(spawn.mock.calls[0]?.[0]).toHaveProperty('launchRuntime')
    // Why: a window wake relaunches a running record, never a pane-owned one.
    expect(storedRecord(fixture)).toMatchObject(PANE_OWNED)
  })

  it('refuses without spawning when a window is already attached', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, attachWindow, resume } = makeRuntime(fixture)
    attachWindow()

    await expect(resume()).resolves.toEqual({ ok: false, reason: 'window_owns_wake' })
    expect(spawn).not.toHaveBeenCalled()
    expect(storedRecord(fixture)).toMatchObject({ state: 'working' })
  })

  it('refuses without spawning when a window attaches while the workspace resolves', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, attachWindow, resume } = makeRuntime(fixture)

    const pending = resume()
    attachWindow()

    await expect(pending).resolves.toEqual({ ok: false, reason: 'window_owns_wake' })
    expect(spawn).not.toHaveBeenCalled()
    expect(storedRecord(fixture)).toMatchObject({ state: 'working' })
  })

  it('refuses without spawning when a window attaches during the duplicate-holder check', async () => {
    const fixture = makeSleptWorkspace()
    let attach = (): void => {}
    const { spawn, attachWindow, resume } = makeRuntime(fixture, {
      rows: () => [sessionRow(`other-tab:${HEADLESS_SECOND_LEAF_ID}`)],
      checkHookAgentPresence: async () => {
        attach()
        return 'exited'
      }
    })
    attach = attachWindow

    await expect(resume()).resolves.toEqual({ ok: false, reason: 'window_owns_wake' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('refuses without spawning when a window attaches before the record claim commits', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, attachWindow, resume } = makeRuntime(fixture)
    const store = fixture.runtimeStore
    if (!('runDurableMutation' in store) || typeof store.runDurableMutation !== 'function') {
      throw new Error('fixture store is not durable')
    }
    const commit = store.runDurableMutation
    Object.assign(store, {
      runDurableMutation: (...args: unknown[]) => {
        attachWindow()
        return Reflect.apply(commit, store, args)
      }
    })

    await expect(resume()).resolves.toEqual({ ok: false, reason: 'window_owns_wake' })
    expect(spawn).not.toHaveBeenCalled()
    expect(storedRecord(fixture)).toMatchObject({ state: 'working' })
  })

  it('keeps the record pane-owned when a window attaches during the spawn', async () => {
    const fixture = makeSleptWorkspace()
    let attach = (): void => {}
    const { spawn, attachWindow, resume } = makeRuntime(fixture, {
      spawn: async () => {
        attach()
        return { id: 'resumed-pty' }
      }
    })
    attach = attachWindow

    await expect(resume()).resolves.toMatchObject({ ok: true })
    expect(resumeSpawns(spawn)).toBe(1)
    expect(storedRecord(fixture)).toMatchObject(PANE_OWNED)
  })

  it('lets only one of a resume and an old-pane open started together own the session', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, resume, openOldPane } = makeRuntime(fixture)

    const [resumed] = await Promise.allSettled([resume(), openOldPane()])

    expect(resumeSpawns(spawn)).toBe(1)
    expect(spawnedCommands(spawn)).toContain('')
    expect(resumed.status).toBe('fulfilled')
  })

  it.each(['resume', 'old pane'] as const)(
    'refuses the other resumer while the %s spawn is in flight',
    async (first) => {
      const fixture = makeSleptWorkspace()
      let landFirstSpawn = (): void => {}
      let firstSpawnStarted = (): void => {}
      const started = new Promise<void>((resolve) => {
        firstSpawnStarted = resolve
      })
      const { spawn, resume, openOldPane } = makeRuntime(fixture, {
        spawn: () => {
          if (spawn.mock.calls.length > 1) {
            return Promise.resolve({ id: 'second-pty' })
          }
          firstSpawnStarted()
          return new Promise((resolve) => {
            landFirstSpawn = () => resolve({ id: 'resumed-pty' })
          })
        }
      })

      if (first === 'resume') {
        const resumed = resume()
        await started
        await openOldPane()
        landFirstSpawn()
        await expect(resumed).resolves.toMatchObject({ ok: true })
        expect(spawnedCommands(spawn)[1]).toBe('')
      } else {
        const opened = openOldPane()
        await started
        await expect(resume()).resolves.toEqual({ ok: false, reason: 'held_elsewhere' })
        landFirstSpawn()
        await opened
      }
      expect(resumeSpawns(spawn)).toBe(1)
    }
  )

  // An SSH resume is never seeded into the hook store, so nothing but the claim names its holder.
  it('keeps the old pane from resuming before the resumed agent reports a hook', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, resume, openOldPane } = makeRuntime(fixture, { rows: () => [] })

    await expect(resume()).resolves.toMatchObject({ ok: true })
    await openOldPane()

    expect(resumeSpawns(spawn)).toBe(1)
    expect(spawnedCommands(spawn)[1]).toBe('')
  })

  it.each([
    ['live', 1],
    ['exited', 2]
  ] as const)(
    'hands the session to the hook-store guard once the resumed pane reports it (%s)',
    async (presence, expectedResumes) => {
      const fixture = makeSleptWorkspace()
      let rows: AgentStatusIpcPayload[] = []
      const { spawn, resume, openOldPane } = makeRuntime(fixture, {
        rows: () => rows,
        checkHookAgentPresence: async () => presence
      })
      const result = await resume()
      if (!result.ok) {
        throw new Error(result.reason)
      }
      rows = [sessionRow(result.paneKey, Date.now())]

      await openOldPane()
      expect(resumeSpawns(spawn)).toBe(expectedResumes)
    }
  )

  it('lets at most one of two concurrent resumes own the session', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, resume } = makeRuntime(fixture)

    const results = await Promise.all([resume(), resume({ mutationId: 'another-delivery' })])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results).toContainEqual({ ok: false, reason: 'held_elsewhere' })
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('shares one spawn between concurrent retries of the same request', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, resume } = makeRuntime(fixture)

    const results = await Promise.all([resume(), resume()])

    expect(results.every((result) => result.ok)).toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('refuses a session captured on another host without spawning', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, resume } = makeRuntime(fixture)

    await expect(resume({ captureHostId: 'ssh:other-box' })).resolves.toEqual({
      ok: false,
      reason: 'no_resume_command'
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('refuses an aborted request without spawning', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, resume } = makeRuntime(fixture)
    const controller = new AbortController()
    controller.abort()

    await expect(resume({ signal: controller.signal })).resolves.toEqual({
      ok: false,
      reason: 'aborted'
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it("reports a failed spawn, never a shell, and keeps the session for that request's retry", async () => {
    const fixture = makeSleptWorkspace()
    let fail = true
    const { spawn, resume } = makeRuntime(fixture, {
      spawn: async () => {
        if (fail) {
          throw new Error('spawn failed')
        }
        return { id: 'resumed-pty' }
      }
    })

    await expect(resume()).resolves.toEqual({ ok: false, reason: 'create_failed' })
    expect(spawnedCommands(spawn).every((command) => command.includes('provider-session-1'))).toBe(
      true
    )
    expect(storedRecord(fixture)).toMatchObject(PANE_OWNED)

    // Why: the spawn request left, so only the same request's pane may retry it.
    await expect(resume({ mutationId: 'another-delivery' })).resolves.toEqual({
      ok: false,
      reason: 'held_elsewhere'
    })
    fail = false
    await expect(resume()).resolves.toMatchObject({ ok: true })
  })
})
