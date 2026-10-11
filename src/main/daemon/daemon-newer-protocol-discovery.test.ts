import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as EndpointProbeModule from './daemon-endpoint-probe'

const probes = vi.hoisted(() => ({
  identity: vi.fn<(pid: number, socketPath: string) => Promise<'match' | 'mismatch' | 'unknown'>>(),
  endpoint:
    vi.fn<(socketPath: string) => Promise<'connected' | 'missing' | 'refused' | 'unknown'>>()
}))
vi.mock('./daemon-pid-identity', () => ({ inspectDaemonProcessIdentity: probes.identity }))
vi.mock('./daemon-endpoint-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointProbeModule>()),
  probeSocketConnect: probes.endpoint
}))

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

async function verdict(): Promise<string | undefined> {
  return (await discoverNewerProtocolDaemons(runtimeDir))[0]?.verdict
}

beforeEach(() => {
  vi.clearAllMocks()
  runtimeDir = mkdtempSync(join(tmpdir(), 'orca-newer-daemon-'))
  otherProfileDir = mkdtempSync(join(tmpdir(), 'orca-newer-daemon-other-'))
  probes.identity.mockResolvedValue('match')
  probes.endpoint.mockResolvedValue('connected')
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

  it('reads a verified daemon as live', async () => {
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
    await expect(verdict()).resolves.toBe('exited')
    expect(readdirSync(runtimeDir).sort()).toEqual([
      `daemon-v${NEWER}.pid`,
      `daemon-v${NEWER}.token`
    ])
    expect(readFileSync(getDaemonPidPath(runtimeDir, NEWER), 'utf8')).toBe(record(42))
  })

  it.each([
    ['connected', 'unverifiable'],
    ['unknown', 'unverifiable'],
    ['refused', 'exited'],
    ['missing', 'exited']
  ] as const)(
    'settles an uninspectable pid by its endpoint: %s is %s',
    async (endpoint, expected) => {
      probes.identity.mockResolvedValue('unknown')
      probes.endpoint.mockResolvedValue(endpoint)
      writePid(runtimeDir, NEWER, record(42))
      await expect(verdict()).resolves.toBe(expected)
    }
  )

  it.each(['', '{"pid":4242,"startedAt', 'not a record'])(
    'never holds forever on an unparseable record %j',
    async (contents) => {
      writePid(runtimeDir, NEWER, contents)
      probes.endpoint.mockResolvedValue('missing')
      await expect(verdict()).resolves.toBe('exited')
      probes.endpoint.mockResolvedValue('connected')
      await expect(verdict()).resolves.toBe('unverifiable')
      expect(probes.identity).not.toHaveBeenCalled()
    }
  )

  it('never consults another profile runtime dir', async () => {
    writePid(otherProfileDir, NEWER, record(42))
    await expect(discoverNewerProtocolDaemons(runtimeDir)).resolves.toEqual([])
    expect(probes.identity).not.toHaveBeenCalled()
  })
})
