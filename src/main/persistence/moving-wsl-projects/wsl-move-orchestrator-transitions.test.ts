import { describe, expect, it } from 'vitest'
import type {
  WslMoveBlocker,
  WslMoveRefusalCode
} from '../../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveOrchestratorRecord } from '../../../shared/wsl-move/wsl-move-orchestrator-types'
import {
  applyWslMovedDistroVerdict,
  applyWslMoveOutcome,
  applyWslMoveUserAction,
  classifyWslMoveOutcome,
  mayStartWslMove,
  newWslMoveOrchestratorRecord,
  settleWslMoveOrchestratorRecord,
  WSL_MOVE_ORCHESTRATOR_BACKOFF_MS,
  WSL_MOVE_ORCHESTRATOR_MAX_ATTEMPTS,
  WSL_MOVE_ORCHESTRATOR_NOT_NOW_MS
} from './wsl-move-orchestrator-transitions'

const NOW = 1_000_000
const context = { now: NOW, appVersion: '1.0.0' }
const blocker: WslMoveBlocker = {
  kind: 'agent-working',
  ids: ['tab:leaf'],
  actions: ['wait', 'end']
}

function record(
  state: WslMoveOrchestratorRecord['state'],
  attempts = 0
): WslMoveOrchestratorRecord {
  return { ...newWslMoveOrchestratorRecord('Ubuntu', '1.0.0', 0), state, attempts }
}

function refused(code: WslMoveRefusalCode) {
  return classifyWslMoveOutcome({ outcome: 'refused', code })
}

describe('classifyWslMoveOutcome', () => {
  it('starts a ready preview and defers one with blockers', () => {
    const ready = {
      outcome: 'ready' as const,
      distro: 'Ubuntu',
      repoIds: ['r1'],
      folderWorkspaceIds: [],
      changed: [],
      heldByHost: [],
      refused: []
    }
    expect(classifyWslMoveOutcome({ ...ready, blockers: [] })).toEqual({ next: 'start' })
    expect(classifyWslMoveOutcome({ ...ready, blockers: [blocker] })).toEqual({
      next: 'deferred',
      blockers: [blocker]
    })
  })

  it('parks what needs the user and backs off what may pass on its own', () => {
    expect(refused('wsl_move_export_incomplete')).toEqual({
      next: 'parked',
      reason: 'export-incomplete'
    })
    expect(refused('wsl_move_manifest_too_large')).toEqual({
      next: 'parked',
      reason: 'manifest-too-large'
    })
    expect(refused('wsl_move_cancelled')).toEqual({ next: 'parked', reason: 'not-now' })
    for (const code of [
      'wsl_move_host_unavailable',
      'wsl_move_already_in_flight',
      'wsl_move_pause_failed',
      'wsl_move_scope_changed',
      'wsl_move_finished_earlier_move',
      'wsl_move_host_update_required'
    ] as const) {
      expect(refused(code)).toEqual({ next: 'transient', reason: code })
    }
    expect(refused('wsl_move_nothing_new')).toEqual({ next: 'idle' })
    expect(refused('wsl_move_already_running')).toEqual({ next: 'stay' })
    expect(
      classifyWslMoveOutcome({
        outcome: 'refused',
        code: 'wsl_move_terminals_blocked',
        blockers: [blocker]
      })
    ).toEqual({ next: 'deferred', blockers: [blocker] })
  })

  it('maps the move results', () => {
    expect(
      classifyWslMoveOutcome({
        outcome: 'moved',
        migrationId: 'm1',
        phase: 'retained',
        reloadRequired: true
      })
    ).toEqual({ next: 'done', migrationId: 'm1' })
    expect(
      classifyWslMoveOutcome({ outcome: 'reset', migrationId: 'm1', detail: 'host_unreachable' })
    ).toEqual({ next: 'transient', reason: 'host_unreachable' })
    expect(
      classifyWslMoveOutcome({ outcome: 'waiting-for-host', migrationId: 'm1', detail: 'x' })
    ).toEqual({ next: 'waiting', migrationId: 'm1' })
  })
})

describe('mayStartWslMove', () => {
  it('never starts a running move, even for the user', () => {
    expect(mayStartWslMove(record({ kind: 'moving' }), 'user', NOW, '1.0.0')).toBe(false)
  })

  it('waits out a backoff unless the user asks', () => {
    const waiting = record({ kind: 'backoff', nextAttemptAt: NOW + 1, reason: 'x' })
    expect(mayStartWslMove(waiting, 'timer', NOW, '1.0.0')).toBe(false)
    expect(mayStartWslMove(waiting, 'timer', NOW + 1, '1.0.0')).toBe(true)
    expect(mayStartWslMove(waiting, 'user', NOW, '1.0.0')).toBe(true)
  })

  it('keeps a parked move parked until the user, its snooze or a new build', () => {
    const snoozed = record({ kind: 'parked', reason: 'not-now', until: NOW + 10 })
    expect(mayStartWslMove(snoozed, 'connect', NOW, '1.0.0')).toBe(false)
    expect(mayStartWslMove(snoozed, 'connect', NOW + 10, '1.0.0')).toBe(true)
    const exhausted = record({ kind: 'parked', reason: 'attempts-exhausted' }, 5)
    expect(mayStartWslMove(exhausted, 'connect', NOW, '1.0.0')).toBe(false)
    expect(mayStartWslMove(exhausted, 'connect', NOW, '1.1.0')).toBe(true)
    const tooLarge = record({ kind: 'parked', reason: 'manifest-too-large' })
    expect(mayStartWslMove(tooLarge, 'connect', NOW, '1.1.0')).toBe(false)
    expect(mayStartWslMove(tooLarge, 'user', NOW, '1.0.0')).toBe(true)
  })

  it('never starts on its own for a gone or replaced distro (R38)', () => {
    expect(mayStartWslMove(record({ kind: 'distro-gone' }), 'connect', NOW, '1.0.0')).toBe(false)
    expect(mayStartWslMove(record({ kind: 'distro-gone' }), 'user', NOW, '1.0.0')).toBe(false)
    expect(mayStartWslMove(record({ kind: 'restore-offered' }), 'connect', NOW, '1.0.0')).toBe(
      false
    )
  })
})

describe('applyWslMoveOutcome', () => {
  it('backs off on the schedule, then parks once attempts run out', () => {
    let current = record({ kind: 'pending' })
    for (let attempt = 1; attempt < WSL_MOVE_ORCHESTRATOR_MAX_ATTEMPTS; attempt++) {
      current = applyWslMoveOutcome(current, { next: 'transient', reason: 'x' }, context)
      expect(current.state).toEqual({
        kind: 'backoff',
        nextAttemptAt: NOW + WSL_MOVE_ORCHESTRATOR_BACKOFF_MS[attempt - 1],
        reason: 'x'
      })
      expect(current.attempts).toBe(attempt)
    }
    current = applyWslMoveOutcome(current, { next: 'transient', reason: 'x' }, context)
    expect(current.state).toEqual({ kind: 'parked', reason: 'attempts-exhausted' })
  })

  it('starts a fresh count on a new build', () => {
    const old = { ...record({ kind: 'pending' }, 4), appVersion: '0.9.0' }
    const next = applyWslMoveOutcome(old, { next: 'transient', reason: 'x' }, context)
    expect(next.attempts).toBe(1)
    expect(next.appVersion).toBe('1.0.0')
  })

  it('parks a host that still needs an update after one retry', () => {
    const reason = 'wsl_move_host_update_required'
    const first = applyWslMoveOutcome(
      record({ kind: 'pending' }),
      { next: 'transient', reason },
      context
    )
    expect(first.state.kind).toBe('backoff')
    const second = applyWslMoveOutcome(first, { next: 'transient', reason }, context)
    expect(second.state).toEqual({ kind: 'parked', reason: 'host-update-required' })
  })

  it('snoozes a cancelled move for a week', () => {
    const next = applyWslMoveOutcome(
      record({ kind: 'moving' }),
      { next: 'parked', reason: 'not-now' },
      context
    )
    expect(next.state).toEqual({
      kind: 'parked',
      reason: 'not-now',
      until: NOW + WSL_MOVE_ORCHESTRATOR_NOT_NOW_MS
    })
  })

  it('keeps a finished distro done when there is nothing new to move', () => {
    const done = record({ kind: 'done', migrationId: 'm1' })
    expect(applyWslMoveOutcome(done, { next: 'idle' }, context)).toBe(done)
    expect(
      applyWslMoveOutcome(record({ kind: 'pending' }), { next: 'idle' }, context).state
    ).toEqual({ kind: 'idle' })
  })

  it('clears the attempt count on success', () => {
    const next = applyWslMoveOutcome(
      record({ kind: 'moving' }, 3),
      { next: 'done', migrationId: 'm1' },
      context
    )
    expect(next).toMatchObject({ state: { kind: 'done', migrationId: 'm1' }, attempts: 0 })
  })
})

describe('R38 verdicts and user actions', () => {
  it('marks a gone or replaced distro and recovers one registered again', () => {
    const done = record({ kind: 'done', migrationId: 'm1' })
    expect(applyWslMovedDistroVerdict(done, 'gone', NOW).state).toEqual({ kind: 'distro-gone' })
    expect(applyWslMovedDistroVerdict(done, 'replaced', NOW).state).toEqual({
      kind: 'restore-offered'
    })
    expect(applyWslMovedDistroVerdict(done, 'unknown', NOW)).toBe(done)
    expect(applyWslMovedDistroVerdict(done, 'present', NOW)).toBe(done)
    expect(
      applyWslMovedDistroVerdict(record({ kind: 'distro-gone' }), 'present', NOW).state
    ).toEqual({ kind: 'pending' })
  })

  it('applies Retry, Not now and Restore, and leaves a running move alone', () => {
    const parked = record({ kind: 'parked', reason: 'attempts-exhausted' }, 5)
    expect(applyWslMoveUserAction(parked, 'retry', NOW, '1.0.0')).toMatchObject({
      state: { kind: 'pending' },
      attempts: 0
    })
    expect(applyWslMoveUserAction(parked, 'not-now', NOW, '1.0.0').state).toEqual({
      kind: 'parked',
      reason: 'not-now',
      until: NOW + WSL_MOVE_ORCHESTRATOR_NOT_NOW_MS
    })
    const moving = record({ kind: 'moving' })
    expect(applyWslMoveUserAction(moving, 'not-now', NOW, '1.0.0')).toBe(moving)
  })

  it('reads a move left running by an earlier process as pending', () => {
    expect(settleWslMoveOrchestratorRecord(record({ kind: 'moving' }), NOW).state).toEqual({
      kind: 'pending'
    })
    const deferred = record({ kind: 'deferred', blockers: [blocker] })
    expect(settleWslMoveOrchestratorRecord(deferred, NOW)).toBe(deferred)
  })
})
