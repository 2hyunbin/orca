import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ORCAD_LOCK_FILE_NAME, readOrcadInstanceLockRecord } from './orcad-instance-lock'
import type { OrcadLockRecord } from './orcad-instance-lock'
import { orcadLockRecoveryPrefix } from './orcad-instance-lock-reclaim'
import {
  probeOrcadEndpoint,
  reclaimStaleOrcadInstanceLock,
  type OrcadStaleLockReclaimHooks
} from './orcad-stale-lock-reclaim'

const roots: string[] = []
const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close()
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

// Why /tmp: a Unix socket path under macOS's long tmpdir exceeds the 104-byte limit.
function makeRoot(): string {
  const root = mkdtempSync('/tmp/orcad-reclaim-')
  roots.push(root)
  return root
}

const HOLDER_PID = 15698

/** The issue's record: written on host `box` in boot-1, ten minutes ago, naming no machine id. */
function holderRecord(overrides: Partial<OrcadLockRecord> = {}): OrcadLockRecord {
  return {
    pid: HOLDER_PID,
    startedAtMs: 1,
    linuxStartTicks: '77',
    bootId: 'boot-1',
    identity: '1000',
    version: '1.0.0',
    acquiredAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    nonce: 'stale-holder',
    role: 'orcad',
    host: 'box',
    ...overrides
  }
}

/** Host `box` after a reboot, with an empty machine id and its home on a network mount. */
function rebootedBox(overrides: OrcadStaleLockReclaimHooks = {}): OrcadStaleLockReclaimHooks {
  return {
    hostname: () => 'box',
    bootId: () => 'boot-2',
    machineIdentity: () => null,
    dataRootIsOnLocalDisk: () => false,
    lockHooks: {
      identity: () => '1000',
      machineIdentity: () => null,
      dataRootIsOnLocalDisk: () => false,
      processIsAlive: () => false,
      incarnation: () => ({ linuxStartTicks: '9', bootId: 'boot-2' })
    },
    ...overrides
  }
}

function writeLock(root: string, record: OrcadLockRecord): string {
  const lockPath = join(root, ORCAD_LOCK_FILE_NAME)
  writeFileSync(lockPath, JSON.stringify(record), { mode: 0o600 })
  const writtenAt = new Date(record.acquiredAt)
  utimesSync(lockPath, writtenAt, writtenAt)
  return lockPath
}

// POSIX ownership, modes and Unix sockets; the command only ever applies to Linux hosts.
describe.skipIf(process.platform === 'win32')('reclaimStaleOrcadInstanceLock (#32177)', () => {
  it('clears a lock from an earlier boot on this host once every check passes and --yes', async () => {
    const root = makeRoot()
    const lockPath = writeLock(root, holderRecord())
    const result = await reclaimStaleOrcadInstanceLock(root, { yes: true }, rebootedBox())
    expect(result.exitCode).toBe(0)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('without --yes, names what it found and warns about other machines, then refuses', async () => {
    const root = makeRoot()
    writeLock(root, holderRecord())
    const result = await reclaimStaleOrcadInstanceLock(root, { yes: false }, rebootedBox())
    expect(result.exitCode).toBe(1)
    for (const evidence of [`pid ${HOLDER_PID}`, 'host box', 'boot boot-1', '10 minutes ago']) {
      expect(result.message).toContain(evidence)
    }
    expect(result.message).toContain('no other machine sharing this home runs Orca')
    expect(readOrcadInstanceLockRecord(join(root, ORCAD_LOCK_FILE_NAME))?.nonce).toBe(
      'stale-holder'
    )
  })

  it('refuses while the holder still answers at its endpoint', async () => {
    const root = makeRoot()
    writeLock(root, holderRecord())
    const server = createServer()
    servers.push(server)
    await new Promise<void>((resolve) =>
      server.listen(join(root, `o-${HOLDER_PID}-rt.sock`), resolve)
    )
    const result = await reclaimStaleOrcadInstanceLock(root, { yes: true }, rebootedBox())
    expect(result).toMatchObject({ exitCode: 1, message: expect.stringContaining('still answers') })
    expect(readOrcadInstanceLockRecord(join(root, ORCAD_LOCK_FILE_NAME))?.nonce).toBe(
      'stale-holder'
    )
  })

  it('also clears a reclaimer from the same earlier boot that the reboot cut short', async () => {
    const root = makeRoot()
    const lockPath = writeLock(root, holderRecord())
    const generation = `${orcadLockRecoveryPrefix(lockPath, readFileSync(lockPath, 'utf8'))}0`
    mkdirSync(generation)
    writeFileSync(
      join(generation, 'owner'),
      JSON.stringify(holderRecord({ pid: 16000, nonce: 'cut-short-reclaimer' }))
    )
    const result = await reclaimStaleOrcadInstanceLock(root, { yes: true }, rebootedBox())
    expect(result.exitCode).toBe(0)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('refuses, rather than reporting nothing to do, when the lock cannot be reached', async () => {
    const root = makeRoot()
    writeLock(root, holderRecord())
    chmodSync(root, 0o000)
    try {
      const result = await reclaimStaleOrcadInstanceLock(root, { yes: true }, rebootedBox())
      expect(result).toMatchObject({
        exitCode: 1,
        message: expect.stringContaining('cannot be read')
      })
    } finally {
      chmodSync(root, 0o700)
    }
  })

  it('probes an IPv6 WebSocket endpoint by its bare address', async () => {
    const server = createServer()
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '::1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await expect(probeOrcadEndpoint(`ws://[::1]:${port}`)).resolves.toBe('answers')
  })

  it.each([
    ['another host', holderRecord({ host: 'other-box' }), 'not this host'],
    // The same boot is this machine's to judge: a normal start does, by its PID.
    ['the same boot', holderRecord({ bootId: 'boot-2' }), 'judge this lock itself'],
    ['an older orcad that recorded no host', holderRecord({ host: undefined }), 'which host'],
    [
      'a lock taken a moment ago',
      holderRecord({ acquiredAt: new Date().toISOString() }),
      'minutes old'
    ]
  ])('refuses a lock from %s', async (_case, record, reason) => {
    const root = makeRoot()
    writeLock(root, record)
    const result = await reclaimStaleOrcadInstanceLock(root, { yes: true }, rebootedBox())
    expect(result).toMatchObject({ exitCode: 1, message: expect.stringContaining(reason) })
    expect(readOrcadInstanceLockRecord(join(root, ORCAD_LOCK_FILE_NAME))?.nonce).toBe(
      'stale-holder'
    )
  })
})
