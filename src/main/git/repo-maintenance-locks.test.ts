import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAINTENANCE_LOCK_STALE_MS } from '../../shared/repo-object-maintenance-policy'
import { removeStaleMaintenanceLocks } from './repo-maintenance-locks'

const runProcessMock = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

const NOW = Date.UTC(2026, 0, 1)
const STALE = MAINTENANCE_LOCK_STALE_MS + 60_000
/** A pid that cannot be alive: above every platform's pid range. */
const DEAD_PID = 2 ** 31 - 2
let commonDir: string

async function writeAged(name: string, content: string, ageMs: number): Promise<void> {
  const path = join(commonDir, name)
  await writeFile(path, content)
  const at = new Date(NOW - ageMs)
  await utimes(path, at, at)
}

async function exists(name: string): Promise<boolean> {
  return stat(join(commonDir, name)).then(
    () => true,
    () => false
  )
}

function processes(...lines: string[]): void {
  runProcessMock.mockResolvedValue({ code: 0, timedOut: false, stdout: lines.join('\n') })
}

const run = () => removeStaleMaintenanceLocks(commonDir, { canInspectProcesses: true, now: NOW })

beforeEach(async () => {
  commonDir = await mkdtemp(join(tmpdir(), 'orca-maintenance-locks-'))
  await mkdir(join(commonDir, 'objects'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  processes('/usr/bin/git fetch origin', 'node server.js')
})

afterEach(async () => {
  vi.restoreAllMocks()
  runProcessMock.mockReset()
  await rm(commonDir, { recursive: true, force: true })
})

describe('stale maintenance lock removal', () => {
  it('removes old maintenance.lock, gc.log.lock and dead gc.pid, but never gc.log', async () => {
    await writeAged('objects/maintenance.lock', '', STALE)
    await writeAged('gc.log.lock', '', STALE)
    await writeAged('gc.pid', `${DEAD_PID} ${hostname()}`, STALE)
    await writeAged('gc.log', 'warning: too many unreachable loose objects\n', STALE)

    const result = await run()

    expect(result.removed).toHaveLength(3)
    expect(result.maintenanceLockHeld).toBe(false)
    expect(await exists('objects/maintenance.lock')).toBe(false)
    expect(await exists('gc.log.lock')).toBe(false)
    expect(await exists('gc.pid')).toBe(false)
    expect(await readFile(join(commonDir, 'gc.log'), 'utf8')).toContain('unreachable')
  })

  it('keeps every lock while git maintenance runs on this host, or when that is unknown', async () => {
    await writeAged('objects/maintenance.lock', '', STALE)
    processes('/usr/bin/git maintenance run --task=geometric-repack')
    expect(await run()).toEqual({ removed: [], maintenanceLockHeld: true })

    runProcessMock.mockResolvedValue({ code: 1, timedOut: false, stdout: '' })
    expect(await run()).toEqual({ removed: [], maintenanceLockHeld: true })
    expect(await exists('objects/maintenance.lock')).toBe(true)
  })

  it('keeps recent locks and a gc.pid whose local owner is alive', async () => {
    await writeAged('objects/maintenance.lock', '', MAINTENANCE_LOCK_STALE_MS - 60_000)
    await writeAged('gc.pid', `${process.pid} ${hostname()}`, STALE)
    expect(await run()).toEqual({ removed: [], maintenanceLockHeld: true })
    expect(await exists('gc.pid')).toBe(true)
  })

  it('removes an old gc.pid that names another host', async () => {
    await writeAged('gc.pid', `${process.pid} another-host`, STALE)
    expect((await run()).removed).toEqual([join(commonDir, 'gc.pid')])
  })

  it('never removes a lock when Git runs under another kernel', async () => {
    await writeAged('objects/maintenance.lock', '', STALE)
    const result = await removeStaleMaintenanceLocks(commonDir, {
      canInspectProcesses: false,
      now: NOW
    })
    expect(result).toEqual({ removed: [], maintenanceLockHeld: true })
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})
