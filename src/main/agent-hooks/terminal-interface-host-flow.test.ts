import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import {
  TerminalInterfaceAuthority,
  type TerminalInterfaceTarget
} from './server/terminal-interface-authority'
import { TerminalRunFactsRegister } from '../runtime/terminal-run-facts'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const probe = vi.hoisted(() => vi.fn(async () => 'exited' as const))
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))
const paneKey = 'tab:11111111-1111-4111-8111-111111111111'
const target: TerminalInterfaceTarget = {
  binding: {
    ptyId: 'pty',
    incarnationId: 'birth',
    terminalHandle: 'handle',
    paneKey,
    worktreeId: 'folder:workspace'
  },
  generation: 1,
  launchToken: null,
  blocked: false,
  local: true
}
const alive: TerminalProcessInspection = {
  foregroundProcess: 'bash.exe',
  hasChildProcesses: true,
  terminalInterface: { shellForeground: false, children: 'children', capturedAgeMs: 0 }
}
const shell: TerminalProcessInspection = {
  foregroundProcess: 'bash.exe',
  hasChildProcesses: false,
  terminalInterface: { shellForeground: true, children: 'no-children', capturedAgeMs: 0 }
}
class HookHost extends AgentHookServer {
  restate(): void {
    const row = this._getStateForTests().lastStatusByPaneKey.get(paneKey)
    if (row) {
      this.applyNormalizedStatus({ ...row, payload: { ...row.payload, prompt: 'restated' } })
    }
  }
  accept(overrides: Partial<AgentHookEventPayload> = {}): void {
    this.applyNormalizedStatus(
      {
        paneKey,
        tabId: 'tab',
        worktreeId: 'folder:workspace',
        terminalHandle: 'handle',
        connectionId: null,
        source: 'claude',
        hookEventName: 'Stop',
        payload: { agentType: 'claude', state: 'done', prompt: '' },
        ...overrides
      },
      undefined,
      'hook',
      undefined,
      undefined,
      false,
      this.terminalInterfaces.captureHook(paneKey, 'handle')
    )
  }
}
const stops: (() => void)[] = []
afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  vi.useRealTimers()
})

function driver(
  authority: TerminalInterfaceAuthority,
  initialResult: TerminalProcessInspection | null = alive
) {
  let inventory = [target]
  let result: TerminalProcessInspection | null = initialResult
  let pending: Promise<TerminalProcessInspection | null> | null = null
  const changed = vi.fn()
  const stop = authority.install({
    inventory: () => inventory,
    inspect: async () => (pending ? await pending : result),
    changed
  })
  stops.push(stop)
  authority.attachHookBindings((key) => {
    const binding = inventory.find((item) => item.binding.paneKey === key)?.binding
    return binding
      ? { terminalHandle: binding.terminalHandle, incarnationId: binding.incarnationId }
      : null
  })
  return {
    changed,
    result: (next: TerminalProcessInspection | null) => {
      result = next
    },
    inventory: (next: TerminalInterfaceTarget[]) => {
      inventory = next
    },
    pending: (next: Promise<TerminalProcessInspection | null> | null) => {
      pending = next
    }
  }
}

describe('execution-host terminal interface flow', () => {
  it('keeps Done while the interface lives, observes a late silent quit and cleans the ordinary shared row without any renderer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const host = new HookHost()
    stops.push(() => host.stop())
    const d = driver(host.terminalInterfaces)
    const mutations = vi.fn()
    host.subscribeStatusRowMutations(mutations)
    host.accept({ payload: { agentType: 'claude', state: 'working', prompt: 'turn' } })
    host.accept()
    host.restate()
    await vi.advanceTimersByTimeAsync(20000)
    expect(host.getStatusSnapshot().some((row) => row.state === 'done')).toBe(true)
    // Same primitive shell name on both sides; no D, title, notification or mounted tracker.
    d.result(shell)
    await vi.advanceTimersByTimeAsync(3000)
    expect(host.terminalInterfaces.read('pty', 'birth')?.state).toBe('shell')
    expect(host.getStatusSnapshot().filter((row) => !row.providerSessionOnly)).toEqual([])
    expect(mutations).toHaveBeenCalled()
    // A new subscriber and rowless remount recover the result from the host collection.
    expect(host.terminalInterfaces.snapshot()[0]?.state).toBe('shell')
    host.dropStatusEntry(paneKey)
    for (const kind of ['driving', 'launch'] as const) {
      host.terminalInterfaces.input('pty', kind)
      expect(host.terminalInterfaces.snapshot()[0]?.state).toBe('shell')
    }
  })

  it('invalidates awaited proof before both driving and launch handoffs, and fences same-agent replacement, sleep and incarnation changes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const authority = new TerminalInterfaceAuthority()
    const d = driver(authority)
    const retired = vi.fn()
    const owner = () => ({
      token: 'owner',
      current: () => true,
      mayRetire: async () => true,
      retire: retired
    })
    authority.captureHook(paneKey, 'handle')(owner())
    await vi.advanceTimersByTimeAsync(1000)
    const facts = new TerminalRunFactsRegister()
    stops.push(facts.onObservationInput((id, kind) => authority.input(id, kind)))
    for (const kind of ['driving', 'launch'] as const) {
      let resolve!: (value: TerminalProcessInspection | null) => void
      d.pending(
        new Promise((done) => {
          resolve = done
        })
      )
      authority.activity('pty')
      await vi.advanceTimersByTimeAsync(1000)
      facts.recordInput('pty', kind, 'sleep 2 && claude\r', 1)
      resolve(shell)
      d.pending(null)
      await Promise.resolve()
      expect(authority.read('pty', 'birth')?.state).not.toBe('shell')
    }
    d.result(shell)
    authority.captureHook(paneKey, 'handle')({ ...owner(), token: 'same-agent-new-owner' })
    d.inventory([{ ...target, blocked: true }])
    await vi.advanceTimersByTimeAsync(4000)
    expect(retired).not.toHaveBeenCalled()
    d.inventory([
      { ...target, generation: 2, binding: { ...target.binding, incarnationId: 'next' } }
    ])
    await vi.advanceTimersByTimeAsync(4000)
    expect(authority.read('pty', 'birth')).toBeNull()
    expect(retired).not.toHaveBeenCalled()
  })

  it('preserves old-daemon omitted proof and remote uncertainty; restored rows never acquire actual lifetime', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const host = new HookHost()
    stops.push(() => host.stop())
    const d = driver(host.terminalInterfaces, {
      foregroundProcess: 'bash',
      hasChildProcesses: false
    })
    host.accept({ isReplay: true, restoredUnconfirmed: true })
    await vi.advanceTimersByTimeAsync(4000)
    expect(host.terminalInterfaces.snapshot()).toEqual([])
    d.result(shell)
    await vi.advanceTimersByTimeAsync(5000)
    expect(host.terminalInterfaces.read('pty', 'birth')?.basis).toBe('cold')
    expect(host.getStatusSnapshot()).not.toEqual([])
    d.inventory([{ ...target, local: false, generation: 3 }])
    d.result(null)
    await vi.advanceTimersByTimeAsync(5000)
    expect(host.terminalInterfaces.snapshot()).toEqual([])
    expect(host.getStatusSnapshot()).not.toEqual([])
  })
  it('captures ingress before an await and associates startup once, never with a later incarnation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const authority = new TerminalInterfaceAuthority()
    const retire = vi.fn()
    const owner = { token: 'original', current: () => true, mayRetire: async () => true, retire }
    const startupReceipt = authority.captureIngress()(paneKey, 'handle')
    const d = driver(authority)
    startupReceipt(owner)
    d.result(shell)
    await vi.advanceTimersByTimeAsync(3000)
    expect(retire).toHaveBeenCalledTimes(1)
    const late = authority.captureIngress()(paneKey, 'handle')
    d.inventory([
      { ...target, generation: 2, binding: { ...target.binding, incarnationId: 'new-birth' } }
    ])
    late({ ...owner, token: 'late' })
    await vi.advanceTimersByTimeAsync(4000)
    expect(retire).toHaveBeenCalledTimes(1)
    expect(authority.read('pty', 'new-birth')?.basis).toBe('cold')
  })

  it('disposes bounded jobs without taking slots from a replacement driver and emits atomic rowless retractions', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const authority = new TerminalInterfaceAuthority()
    const d = driver(authority)
    d.pending(new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(1250)
    const events: ReturnType<TerminalInterfaceAuthority['snapshotEvent']>[] = []
    let inventory = [{ ...target, binding: { ...target.binding, incarnationId: 'replacement' } }]
    const inspect = vi.fn(async () => shell)
    stops.push(
      authority.install({
        inventory: () => inventory,
        inspect,
        changed: () => events.push(authority.snapshotEvent())
      })
    )
    await vi.advanceTimersByTimeAsync(2500)
    expect(authority.read('pty', 'replacement')?.state).toBe('shell')
    expect(inspect).toHaveBeenCalled()
    inventory = []
    const retracted = authority.snapshotEvent()
    expect(retracted.observations).toEqual([])
    expect(events.at(-1)).toEqual(retracted)
    expect(retracted.revision).toBeGreaterThan(events.at(-2)?.revision ?? -1)
  })
})
