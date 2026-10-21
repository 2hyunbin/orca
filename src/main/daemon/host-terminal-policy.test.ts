import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostTerminalPolicy, hostTerminalPolicyPath } from './host-terminal-policy'
import { SystemPtyLimit, parseLinuxPtyLimit } from './system-pty-limit'
import { HostTerminalLedger } from './host-terminal-ledger'
import { TerminalSpawnGate } from './terminal-spawn-gate'
import type { SpawnRequestFacts } from '../../shared/host-spawn-admission'

const facts: SpawnRequestFacts = {
  clientId: 'user',
  declaredIntent: null,
  hasAgentSessionClaim: false,
  hasHistorySeed: false,
  deadlineAt: Number.POSITIVE_INFINITY
}
const system = () => new SystemPtyLimit(async () => 511)
const directories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'orca-terminal-policy-'))
  directories.push(path)
  return path
}

describe('host terminal policy', () => {
  it('shares live raises and decreases across daemons and retains the policy after reconstruction', async () => {
    const root = await home()
    const path = hostTerminalPolicyPath(root, 'machine-a')
    const first = new HostTerminalPolicy(path, {}, system())
    const second = new HostTerminalPolicy(path, {}, system())
    const gate = (policy: HostTerminalPolicy, pid: number) =>
      new TerminalSpawnGate({
        log: vi.fn(),
        resolveMaximum: () => policy.admissionMaximum(),
        hostTerminals: new HostTerminalLedger({
          dir: join(root, 'ledger'),
          pid,
          maxTerminals: 256,
          isProcessAlive: () => true,
          log: vi.fn()
        })
      })
    const desktop = gate(first, 100)
    const server = gate(second, 200)
    await first.save(1, () => true)
    const running = await desktop.admit(facts)
    running.commit('existing-shell', true)
    await expect(server.admit(facts)).rejects.toThrow()
    await first.save(2, () => true)
    const setup = await server.admit(facts)
    setup.commit('setup-script', true)
    await first.save(1, () => true)
    await expect(server.admit(facts)).rejects.toThrow()
    expect(desktop.snapshot().terminals).toBe(1)
    expect(server.snapshot().terminals).toBe(1)
    const restarted = new HostTerminalPolicy(path, {}, system())
    expect(await restarted.admissionMaximum()).toBe(1)
    desktop.onSessionExit('existing-shell')
    await expect(server.admit(facts)).rejects.toThrow()
    server.onSessionExit('setup-script')
    const next = await server.admit(facts)
    next.abandon()
    desktop.stopHostTerminals()
    server.stopHostTerminals()
  })

  it('validates the host ceiling, preserves environment priority and never shares a missing machine identity', async () => {
    const root = await home()
    const path = hostTerminalPolicyPath(root, 'machine-a')
    expect(path).not.toBe(hostTerminalPolicyPath(root, 'machine-b'))
    expect(hostTerminalPolicyPath(root, null)).toBeNull()
    const policy = new HostTerminalPolicy(path, {}, system())
    await expect(policy.save(512, () => true)).rejects.toThrow('capacity')
    await policy.save(384, () => true)
    expect(await policy.status('nonce')).toMatchObject({
      maxTerminals: 384,
      source: 'saved',
      systemPtyLimit: 511
    })
    const override = new HostTerminalPolicy(
      path,
      { ORCA_DAEMON_MAX_HOST_TERMINALS: '600' },
      system()
    )
    expect(await override.status('nonce')).toMatchObject({
      maxTerminals: 600,
      source: 'environment',
      editable: false
    })
    await expect(override.save(20, () => true)).rejects.toThrow('unavailable')
    const unidentified = new HostTerminalPolicy(null, {}, system())
    expect(await unidentified.status('nonce')).toMatchObject({ maxTerminals: 256, editable: false })
    await expect(unidentified.save(10, () => true)).rejects.toThrow()
    const reduced = new HostTerminalPolicy(path, {}, new SystemPtyLimit(async () => 128))
    expect(await reduced.status('nonce')).toMatchObject({ maxTerminals: 384, systemPtyLimit: 128 })
    const defaults = new HostTerminalPolicy(null, {}, new SystemPtyLimit(async () => 128))
    expect(await defaults.status('nonce')).toMatchObject({ maxTerminals: 256, systemPtyLimit: 128 })
  })

  it('bounds admission wait while retaining one stalled underlying read', async () => {
    vi.useFakeTimers()
    const read = vi.fn(() => new Promise<number | null>(() => {}))
    const policy = new HostTerminalPolicy('/unreachable/terminal-policy', {}, system(), read)
    const attempts = Promise.all([policy.admissionMaximum(), policy.admissionMaximum()])
    await vi.advanceTimersByTimeAsync(251)
    expect(await attempts).toEqual([256, 256])
    const retry = policy.admissionMaximum()
    await vi.advanceTimersByTimeAsync(251)
    expect(await retry).toBe(256)
    expect(read).toHaveBeenCalledOnce()
  })

  it('reports Linux configured global and devpts capacity without subtracting namespace reserve', () => {
    expect(parseLinuxPtyLimit('4096\n', 'devpts /dev/pts devpts rw,max=128 0 0')).toBe(128)
    expect(parseLinuxPtyLimit('4096', 'devpts /dev/pts devpts rw 0 0')).toBe(4096)
    expect(parseLinuxPtyLimit('garbage', '')).toBeNull()
  })
})
