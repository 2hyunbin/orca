import { describe, expect, it, vi } from 'vitest'
import type {
  WslMoveBlocker,
  WslMovePreview,
  WslMoveResult
} from '../../../shared/wsl-move/wsl-move-driver-types'
import { wslMoveJournalKey } from '../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveOrchestratorRecord } from '../../../shared/wsl-move/wsl-move-orchestrator-types'
import { WslMoveOrchestrator, type WslMoveOrchestratorPorts } from './wsl-move-orchestrator'
import {
  WSL_MOVE_ORCHESTRATOR_BACKOFF_MS,
  WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS
} from './wsl-move-orchestrator-transitions'

const blocker: WslMoveBlocker = { kind: 'agent-working', ids: ['tab:leaf'], actions: ['wait'] }

function ready(distro: string, blockers: WslMoveBlocker[] = []): WslMovePreview {
  return {
    outcome: 'ready',
    distro,
    repoIds: ['r1'],
    folderWorkspaceIds: [],
    changed: [],
    heldByHost: [],
    refused: [],
    blockers
  }
}

const moved: WslMoveResult = {
  outcome: 'moved',
  migrationId: 'm1',
  phase: 'retained',
  reloadRequired: true
}

type Fake = WslMoveOrchestratorPorts & {
  clock: { now: number }
  timers: { at: number; run: () => void; cancelled: boolean }[]
  saved: Map<string, WslMoveOrchestratorRecord>
  advance: (ms: number) => Promise<void>
}

function fakePorts(overrides: Partial<WslMoveOrchestratorPorts> = {}): Fake {
  const clock = { now: 1_000 }
  const timers: Fake['timers'] = []
  const saved = new Map<string, WslMoveOrchestratorRecord>()
  const ports: Fake = {
    clock,
    timers,
    saved,
    now: () => clock.now,
    appVersion: '1.0.0',
    autoMoveEnabled: () => true,
    isHostReady: () => true,
    preview: vi.fn(async (distro: string) => ready(distro)),
    start: vi.fn(async () => moved),
    finishedMove: () => null,
    checkMovedDistro: vi.fn(async () => 'present' as const),
    releaseFinishedMove: vi.fn(async () => ({
      released: true as const,
      distro: 'Ubuntu',
      repoIds: ['r1'],
      folderWorkspaceIds: []
    })),
    load: () => new Map(),
    save: (records) => {
      saved.clear()
      for (const [key, value] of records) {
        saved.set(key, value)
      }
    },
    schedule: (delayMs, run) => {
      const timer = { at: clock.now + delayMs, run, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    track: vi.fn(),
    publish: vi.fn(),
    advance: async (ms) => {
      clock.now += ms
      for (const timer of timers.splice(0)) {
        if (!timer.cancelled && timer.at <= clock.now) {
          timer.run()
        } else if (!timer.cancelled) {
          timers.push(timer)
        }
      }
      // Let the triggered runs settle their awaited ports.
      for (let turn = 0; turn < 10; turn++) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    },
    ...overrides
  }
  return ports
}

function stateOf(orchestrator: WslMoveOrchestrator, distro: string) {
  return orchestrator.list().find((record) => record.distro === distro)?.state
}

describe('WslMoveOrchestrator', () => {
  it('moves two distros independently: one finishes, the busy one waits (fake transport)', async () => {
    const ports = fakePorts({
      preview: vi.fn(async (distro: string) =>
        distro === 'Debian' ? ready(distro, [blocker]) : ready(distro)
      )
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await Promise.all([
      orchestrator.trigger('Ubuntu', 'connect'),
      orchestrator.trigger('Debian', 'connect')
    ])
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
    expect(stateOf(orchestrator, 'Debian')).toEqual({ kind: 'deferred', blockers: [blocker] })
    expect(ports.start).toHaveBeenCalledTimes(1)
    expect(ports.start).toHaveBeenCalledWith('Ubuntu')
    expect(ports.saved.get(wslMoveJournalKey('Debian'))?.state.kind).toBe('deferred')
  })

  it('never wakes a distro on its own (A1): no ready host, no preview', async () => {
    const ports = fakePorts({ isHostReady: () => false })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    await orchestrator.trigger('Ubuntu', 'startup')
    expect(ports.preview).not.toHaveBeenCalled()
    // An explicit user action is the user's choice to wake it.
    await orchestrator.trigger('Ubuntu', 'user')
    expect(ports.preview).toHaveBeenCalledTimes(1)
  })

  it('makes no automatic start with the kill switch off, but still runs Move now', async () => {
    const ports = fakePorts({ autoMoveEnabled: () => false })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(ports.preview).not.toHaveBeenCalled()
    await orchestrator.userAction('Ubuntu', 'move-now')
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
  })

  it('re-checks a deferred move on its timer and starts once the terminals are free', async () => {
    let busy = true
    const ports = fakePorts({
      preview: vi.fn(async (distro: string) => (busy ? ready(distro, [blocker]) : ready(distro)))
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(stateOf(orchestrator, 'Ubuntu')?.kind).toBe('deferred')
    busy = false
    await ports.advance(WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS)
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
  })

  it('backs off a reset move and retries on its timer while the host stays ready', async () => {
    const start = vi
      .fn<WslMoveOrchestratorPorts['start']>()
      .mockResolvedValueOnce({ outcome: 'reset', migrationId: 'm0', detail: 'ECONNRESET' })
      .mockResolvedValueOnce(moved)
    const ports = fakePorts({ start })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(stateOf(orchestrator, 'Ubuntu')).toMatchObject({ kind: 'backoff', reason: 'ECONNRESET' })
    await ports.advance(WSL_MOVE_ORCHESTRATOR_BACKOFF_MS[0] - 1)
    expect(start).toHaveBeenCalledTimes(1)
    await ports.advance(1)
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
  })

  it('treats a port that throws as a transient failure', async () => {
    const ports = fakePorts({
      preview: vi.fn(async () => {
        throw new Error('wsl_move_window_unavailable')
      })
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(stateOf(orchestrator, 'Ubuntu')).toMatchObject({
      kind: 'backoff',
      reason: 'wsl_move_window_unavailable'
    })
  })

  it('absorbs a trigger that arrives while the distro is already being handled', async () => {
    let release: () => void = () => {}
    const ports = fakePorts({
      preview: vi.fn(
        () =>
          new Promise<WslMovePreview>((resolve) => {
            release = () => resolve(ready('Ubuntu'))
          })
      )
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    const first = orchestrator.trigger('Ubuntu', 'connect')
    await orchestrator.trigger('ubuntu', 'project-opened')
    release()
    await first
    expect(ports.preview).toHaveBeenCalledTimes(1)
  })

  it('reports each state change once, not each unchanged re-check', async () => {
    const ports = fakePorts({
      preview: vi.fn(async (distro: string) => ready(distro, [blocker]))
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    await ports.advance(WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS)
    await ports.advance(WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS)
    expect(vi.mocked(ports.track).mock.calls.map(([, record]) => record.state.kind)).toEqual([
      'deferred'
    ])
  })

  it('marks a finished move whose distro is gone and never previews it (R38)', async () => {
    const ports = fakePorts({
      finishedMove: () => ({ migrationId: 'm1', distroGuid: 'guid' }),
      checkMovedDistro: vi.fn(async () => 'gone' as const)
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'distro-gone' })
    expect(ports.preview).not.toHaveBeenCalled()
  })

  it('offers Restore for a replaced distro, releases the move, then moves on the next trigger', async () => {
    let verdict: 'replaced' | 'present' = 'replaced'
    let finished: { migrationId: string } | null = { migrationId: 'm1' }
    const ports = fakePorts({
      finishedMove: () => finished,
      checkMovedDistro: vi.fn(async () => verdict),
      releaseFinishedMove: vi.fn(async () => {
        finished = null
        verdict = 'present'
        return {
          released: true as const,
          distro: 'Ubuntu',
          repoIds: ['r1'],
          folderWorkspaceIds: []
        }
      })
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'restore-offered' })
    const { release } = await orchestrator.userAction('Ubuntu', 'restore', {
      unsavedWorkspaceIds: ['wt']
    })
    expect(release).toMatchObject({ released: true })
    expect(ports.releaseFinishedMove).toHaveBeenCalledWith('Ubuntu', ['wt'])
    // The window reloads after a release; the move waits for the next trigger.
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'pending' })
    expect(ports.preview).not.toHaveBeenCalled()
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'done', migrationId: 'm1' })
  })

  it('keeps Restore offered when the release is refused', async () => {
    const ports = fakePorts({
      finishedMove: () => ({ migrationId: 'm1' }),
      checkMovedDistro: vi.fn(async () => 'replaced' as const),
      releaseFinishedMove: vi.fn(async () => ({
        released: false as const,
        reason: 'unsaved-files' as const,
        unsavedWorkspaceIds: ['wt']
      }))
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    const { record, release } = await orchestrator.userAction('Ubuntu', 'restore')
    expect(release).toMatchObject({ released: false, reason: 'unsaved-files' })
    expect(record.state).toEqual({ kind: 'restore-offered' })
  })

  it('snoozes on Not now and leaves the distro alone until it expires', async () => {
    const ports = fakePorts()
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.userAction('Ubuntu', 'not-now')
    await orchestrator.trigger('Ubuntu', 'connect')
    expect(ports.preview).not.toHaveBeenCalled()
    expect(stateOf(orchestrator, 'Ubuntu')).toMatchObject({ kind: 'parked', reason: 'not-now' })
  })

  it('resumes from its sidecar: a move left running is pending, a backoff is rescheduled', async () => {
    const loaded = new Map<string, WslMoveOrchestratorRecord>([
      [
        wslMoveJournalKey('Ubuntu'),
        {
          distro: 'Ubuntu',
          state: { kind: 'moving' },
          attempts: 0,
          appVersion: '1.0.0',
          updatedAt: 0
        }
      ],
      [
        wslMoveJournalKey('Debian'),
        {
          distro: 'Debian',
          state: { kind: 'backoff', nextAttemptAt: 1_500, reason: 'x' },
          attempts: 1,
          appVersion: '1.0.0',
          updatedAt: 0
        }
      ]
    ])
    const ports = fakePorts({ load: () => loaded })
    const orchestrator = new WslMoveOrchestrator(ports)
    expect(stateOf(orchestrator, 'Ubuntu')).toEqual({ kind: 'pending' })
    await ports.advance(500)
    expect(stateOf(orchestrator, 'Debian')).toEqual({ kind: 'done', migrationId: 'm1' })
  })

  it('stops its timers on dispose', async () => {
    const ports = fakePorts({
      preview: vi.fn(async (distro: string) => ready(distro, [blocker]))
    })
    const orchestrator = new WslMoveOrchestrator(ports)
    await orchestrator.trigger('Ubuntu', 'connect')
    orchestrator.dispose()
    await ports.advance(WSL_MOVE_ORCHESTRATOR_DEFERRED_RECHECK_MS)
    expect(ports.preview).toHaveBeenCalledTimes(1)
  })
})
