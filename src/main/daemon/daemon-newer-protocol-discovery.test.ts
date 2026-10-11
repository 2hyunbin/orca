import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const probes = vi.hoisted(() => ({
  identity: vi.fn<(pid: number, socketPath: string) => Promise<'match' | 'mismatch' | 'unknown'>>(),
  socket: vi.fn<(socketPath: string) => Promise<boolean>>(),
  signal: vi.fn<(pid: number) => 'occupied' | 'missing' | 'permission_denied' | 'unavailable'>()
}))
vi.mock('./daemon-pid-identity', () => ({ inspectDaemonProcessIdentity: probes.identity }))
vi.mock('./daemon-launch-paths', () => ({ probeDaemonSocket: probes.socket }))
vi.mock('./daemon-process-inspection', () => ({ inspectProcessSignal: probes.signal }))

import { discoverNewerProtocolDaemons } from './daemon-newer-protocol-discovery'
import { getDaemonPidPath } from './daemon-spawner'
import { PROTOCOL_VERSION } from './types'

const NEWER = PROTOCOL_VERSION + 1

let runtimeDir: string
let otherProfileDir: string

function writePid(dir: string, protocolVersion: number, contents: string): void {
  writeFileSync(getDaemonPidPath(dir, protocolVersion), contents)
}

function record(pid: number): string {
  return JSON.stringify({ pid, startedAtMs: 1_700_000_000_000, launchNonce: 'n' })
}

beforeEach(() => {
  vi.clearAllMocks()
  runtimeDir = mkdtempSync(join(tmpdir(), 'orca-newer-daemon-'))
  otherProfileDir = mkdtempSync(join(tmpdir(), 'orca-newer-daemon-other-'))
  probes.identity.mockResolvedValue('match')
  probes.socket.mockResolvedValue(true)
  probes.signal.mockReturnValue('missing')
})

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true })
  rmSync(otherProfileDir, { recursive: true, force: true })
})

describe('discoverNewerProtocolDaemons', () => {
  it('finds nothing when only this and older protocols have records', async () => {
    writePid(runtimeDir, PROTOCOL_VERSION, record(10))
    writePid(runtimeDir, PROTOCOL_VERSION - 1, record(11))
    await expect(discoverNewerProtocolDaemons(runtimeDir)).resolves.toEqual([])
    expect(probes.identity).not.toHaveBeenCalled()
  })

  it('reads a verified daemon answering on its socket as live', async () => {
    writePid(runtimeDir, NEWER, record(42))
    await expect(discoverNewerProtocolDaemons(runtimeDir)).resolves.toEqual([
      { protocolVersion: NEWER, verdict: 'live' }
    ])
    expect(probes.identity).toHaveBeenCalledWith(
      42,
      expect.stringContaining(`v${NEWER}`),
      expect.stringContaining(`v${NEWER}`),
      1_700_000_000_000
    )
  })

  it('reads a gone or recycled pid as exited and leaves the newer files alone', async () => {
    probes.identity.mockResolvedValue('mismatch')
    writePid(runtimeDir, NEWER, record(42))
    writeFileSync(join(runtimeDir, `daemon-v${NEWER}.token`), 'secret')
    await expect(discoverNewerProtocolDaemons(runtimeDir)).resolves.toEqual([
      { protocolVersion: NEWER, verdict: 'exited' }
    ])
    expect(readdirSync(runtimeDir).sort()).toEqual([
      `daemon-v${NEWER}.pid`,
      `daemon-v${NEWER}.token`
    ])
    expect(readFileSync(getDaemonPidPath(runtimeDir, NEWER), 'utf8')).toBe(record(42))
  })

  it('reads an uninspectable pid as unverifiable', async () => {
    probes.identity.mockResolvedValue('unknown')
    writePid(runtimeDir, NEWER, record(42))
    await expect(discoverNewerProtocolDaemons(runtimeDir)).resolves.toEqual([
      { protocolVersion: NEWER, verdict: 'unverifiable' }
    ])
  })

  it('reads a verified daemon whose socket does not answer as unverifiable', async () => {
    probes.socket.mockResolvedValue(false)
    writePid(runtimeDir, NEWER, record(42))
    await expect(discoverNewerProtocolDaemons(runtimeDir)).resolves.toEqual([
      { protocolVersion: NEWER, verdict: 'unverifiable' }
    ])
  })

  it('reads an empty record mid-publish as unverifiable, never pid 0', async () => {
    writePid(runtimeDir, NEWER, '')
    await expect(discoverNewerProtocolDaemons(runtimeDir)).resolves.toEqual([
      { protocolVersion: NEWER, verdict: 'unverifiable' }
    ])
    expect(probes.identity).not.toHaveBeenCalled()
  })

  it('judges a torn record by its salvaged pid', async () => {
    writePid(runtimeDir, NEWER, '{"pid":4242,"startedAt')
    probes.signal.mockReturnValue('occupied')
    await expect(discoverNewerProtocolDaemons(runtimeDir)).resolves.toEqual([
      { protocolVersion: NEWER, verdict: 'unverifiable' }
    ])
    probes.signal.mockReturnValue('missing')
    await expect(discoverNewerProtocolDaemons(runtimeDir)).resolves.toEqual([
      { protocolVersion: NEWER, verdict: 'exited' }
    ])
    expect(probes.signal).toHaveBeenCalledWith(4242)
  })

  it('never consults another profile runtime dir', async () => {
    writePid(otherProfileDir, NEWER, record(42))
    await expect(discoverNewerProtocolDaemons(runtimeDir)).resolves.toEqual([])
    expect(probes.identity).not.toHaveBeenCalled()
  })
})
