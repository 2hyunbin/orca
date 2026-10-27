import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WslRelayRecovery, type WslRelayRecoveryState } from './wsl-hook-relay-recovery'
import { restartWslRelay } from './wsl-hook-relay-state-machine'

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))

afterEach(() => vi.useRealTimers())

function makeState(): WslRelayRecoveryState {
  return { distro: 'Ubuntu', cooldownUntil: Date.now() - 1_000 }
}

function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  return vi.waitFor(() => expect(condition()).toBe(true), { timeout: timeoutMs })
}

describe('WslRelayRecovery', () => {
  it('re-ensures the distro when the restart timer fires and the distro is running', async () => {
    const restart = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: async () => true,
      deferUntilRunning: vi.fn(),
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => true,
      restart,
      dropState: vi.fn()
    })
    const state = makeState()
    recovery.scheduleRestart(state)
    await vi.advanceTimersByTimeAsync(250)
    await waitFor(() => restart.mock.calls.length === 1)
    expect(restart).toHaveBeenCalledWith('Ubuntu', { codexHomePath: undefined, launchKinds: [] })
  })

  it('drops the state instead of booting a stopped distro', async () => {
    const restart = vi.fn()
    const dropState = vi.fn()
    const warn = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: async () => false,
      deferUntilRunning: vi.fn(),
      warn,
      isDisposed: () => false,
      isCurrent: () => true,
      restart,
      dropState
    })
    const state = makeState()
    recovery.scheduleRestart(state)
    await vi.advanceTimersByTimeAsync(250)
    await waitFor(() => dropState.mock.calls.length === 1)
    expect(restart).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('distro not running'))
  })

  it('after a terminate, stays down and comes back only once the distro runs again (E9)', async () => {
    const restart = vi.fn()
    const dropState = vi.fn()
    const deferred: (() => void)[] = []
    const isDistroRunning = vi.fn(async (_distro: string, _startedAfter: number) => false)
    const recovery = new WslRelayRecovery({
      isDistroRunning,
      deferUntilRunning: (_distro, task) => deferred.push(task),
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => true,
      restart,
      dropState
    })
    const state = makeState()
    const beforeDeath = performance.now()
    recovery.scheduleRestart(state)
    await vi.advanceTimersByTimeAsync(250)
    await waitFor(() => dropState.mock.calls.length === 1)
    // The running-list read must have started after the link died, never a stale earlier one.
    expect(isDistroRunning.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(beforeDeath)
    expect(restart).not.toHaveBeenCalled()
    expect(deferred).toHaveLength(1)
    // Something else (the user) started the distro: only now does the relay come back.
    deferred[0]()
    expect(restart).toHaveBeenCalledExactlyOnceWith('Ubuntu', {
      codexHomePath: undefined,
      launchKinds: []
    })
  })

  it('brings back the Codex home and pi/omp setups that dropState discarded', async () => {
    const restart = vi.fn()
    const deferred: (() => void)[] = []
    const recovery = new WslRelayRecovery({
      isDistroRunning: async () => false,
      deferUntilRunning: (_distro, task) => deferred.push(task),
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => true,
      restart,
      dropState: (state) => {
        state.codexHomePath = undefined
        state.launchKinds = undefined
      }
    })
    const state: WslRelayRecoveryState = {
      ...makeState(),
      codexHomePath: '/home/u/.orca-codex',
      launchKinds: new Set(['pi', 'omp'])
    }
    recovery.scheduleRestart(state)
    await vi.advanceTimersByTimeAsync(250)
    await waitFor(() => deferred.length === 1)
    deferred[0]()
    expect(restart).toHaveBeenCalledExactlyOnceWith('Ubuntu', {
      codexHomePath: '/home/u/.orca-codex',
      launchKinds: ['pi', 'omp']
    })
  })

  it('re-probes once after a stopped verdict and restarts only once', async () => {
    const restart = vi.fn()
    const deferred: (() => void)[] = []
    const isDistroRunning = vi.fn(async () => false)
    const recovery = new WslRelayRecovery({
      isDistroRunning,
      deferUntilRunning: (_distro, task) => deferred.push(task),
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => true,
      restart,
      dropState: vi.fn()
    })
    recovery.scheduleRestart(makeState())
    await vi.advanceTimersByTimeAsync(250)
    await waitFor(() => deferred.length === 1)
    // The first read was wrong (the distro was still running): the re-probe recovers it.
    isDistroRunning.mockResolvedValue(true)
    await vi.advanceTimersByTimeAsync(30_000)
    await waitFor(() => restart.mock.calls.length === 1)
    deferred[0]()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(isDistroRunning).toHaveBeenCalledTimes(2)
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the state was replaced before the restart probe', async () => {
    const restart = vi.fn()
    const probe = vi.fn(async () => true)
    const recovery = new WslRelayRecovery({
      isDistroRunning: probe,
      deferUntilRunning: vi.fn(),
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => false,
      restart,
      dropState: vi.fn()
    })
    const state = makeState()
    recovery.scheduleRestart(state)
    await vi.advanceTimersByTimeAsync(500)
    expect(probe).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })

  it('does not drop or restart when the state was replaced mid-probe (probe false)', async () => {
    let current = true
    let resolveProbe: ((running: boolean) => void) | undefined
    const probe = vi.fn(() => new Promise<boolean>((resolve) => (resolveProbe = resolve)))
    const restart = vi.fn()
    const dropState = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: probe,
      deferUntilRunning: vi.fn(),
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => current,
      restart,
      dropState
    })
    const state = makeState()
    recovery.scheduleRestart(state)
    await vi.advanceTimersByTimeAsync(250)
    await waitFor(() => probe.mock.calls.length === 1)
    current = false
    resolveProbe?.(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(dropState).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })

  it('does not restart when the state was replaced mid-probe (probe true)', async () => {
    let current = true
    let resolveProbe: ((running: boolean) => void) | undefined
    const probe = vi.fn(() => new Promise<boolean>((resolve) => (resolveProbe = resolve)))
    const restart = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: probe,
      deferUntilRunning: vi.fn(),
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => current,
      restart,
      dropState: vi.fn()
    })
    const state = makeState()
    recovery.scheduleRestart(state)
    await vi.advanceTimersByTimeAsync(250)
    await waitFor(() => probe.mock.calls.length === 1)
    current = false
    resolveProbe?.(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(restart).not.toHaveBeenCalled()
  })

  it('scheduleOneShotReinstall is a no-op once disposed', async () => {
    const run = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: async () => true,
      deferUntilRunning: vi.fn(),
      warn: vi.fn(),
      isDisposed: () => true,
      isCurrent: () => true,
      restart: vi.fn(),
      dropState: vi.fn()
    })
    const state = makeState()
    recovery.scheduleOneShotReinstall(state, 10, run)
    await vi.advanceTimersByTimeAsync(100)
    expect(run).not.toHaveBeenCalled()
    expect(state.reinstallTimer).toBeUndefined()
  })

  it('clearTimers cancels both pending timers', async () => {
    const restart = vi.fn()
    const recovery = new WslRelayRecovery({
      isDistroRunning: async () => true,
      deferUntilRunning: vi.fn(),
      warn: vi.fn(),
      isDisposed: () => false,
      isCurrent: () => true,
      restart,
      dropState: vi.fn()
    })
    const state = makeState()
    const reinstall = vi.fn()
    recovery.scheduleRestart(state)
    recovery.scheduleOneShotReinstall(state, 100, reinstall)
    recovery.clearTimers(state)
    await vi.advanceTimersByTimeAsync(500)
    expect(restart).not.toHaveBeenCalled()
    expect(reinstall).not.toHaveBeenCalled()
    expect(state.restartTimer).toBeUndefined()
    expect(state.reinstallTimer).toBeUndefined()
  })
})

describe('restartWslRelay', () => {
  it('re-ensures the base relay and every captured pi/omp setup with the captured Codex home', () => {
    const ensure = vi.fn(async () => {})
    restartWslRelay(ensure, 'Ubuntu', { codexHomePath: '/h', launchKinds: ['pi', 'omp'] }, '/now')
    expect(ensure.mock.calls).toEqual([
      ['Ubuntu', '/h'],
      ['Ubuntu', '/h', 'pi'],
      ['Ubuntu', '/h', 'omp']
    ])
  })

  it('falls back to the live Codex home when nothing was captured', () => {
    const ensure = vi.fn(async () => {})
    restartWslRelay(ensure, 'Ubuntu', undefined, '/now')
    expect(ensure.mock.calls).toEqual([['Ubuntu', '/now']])
  })
})
