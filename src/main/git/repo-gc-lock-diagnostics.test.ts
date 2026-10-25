import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inspectRepoGcLocks } from './repo-gc-lock-diagnostics'

const DAY_MS = 24 * 60 * 60_000
let commonDir: string

async function writeAged(name: string, content: string, ageMs: number): Promise<void> {
  const path = join(commonDir, name)
  await writeFile(path, content)
  const at = new Date(Date.now() - ageMs)
  await utimes(path, at, at)
}

async function exists(name: string): Promise<boolean> {
  return stat(join(commonDir, name)).then(
    () => true,
    () => false
  )
}

/** A pid that cannot be alive: above every platform's pid range. */
const DEAD_PID = 2 ** 31 - 2

beforeEach(async () => {
  commonDir = await mkdtemp(join(tmpdir(), 'orca-gc-locks-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(commonDir, { recursive: true, force: true })
})

describe('gc lock diagnostics', () => {
  it('removes a day-old gc.log.lock left by a crashed gc, but keeps gc.log', async () => {
    await writeAged('gc.log.lock', 'fatal: fork failed\n', 2 * DAY_MS)
    await writeAged('gc.log', 'warning: There are too many unreachable loose objects\n', 2 * DAY_MS)

    const result = await inspectRepoGcLocks(commonDir, { canProbePids: true })

    expect(result).toMatchObject({ gcPid: 'absent', removedStaleGcLogLock: true })
    expect(result.staleGcLogBytes).toBeGreaterThan(0)
    expect(await exists('gc.log.lock')).toBe(false)
    expect(await readFile(join(commonDir, 'gc.log'), 'utf8')).toContain('unreachable')
  })

  it('leaves a recent gc.log.lock, or one guarded by a live gc, alone', async () => {
    await writeAged('gc.log.lock', '', 60_000)
    expect(
      (await inspectRepoGcLocks(commonDir, { canProbePids: true })).removedStaleGcLogLock
    ).toBe(false)

    await writeAged('gc.log.lock', '', 2 * DAY_MS)
    await writeAged('gc.pid', `${process.pid} ${hostname()}`, 60_000)
    const result = await inspectRepoGcLocks(commonDir, { canProbePids: true })
    expect(result).toMatchObject({ gcPid: 'live', removedStaleGcLogLock: false })
    expect(await exists('gc.log.lock')).toBe(true)
  })

  it('reads gc.pid as stale when its pid is dead here or it is older than 12h', async () => {
    await writeAged('gc.pid', `${DEAD_PID} ${hostname()}`, 60_000)
    expect((await inspectRepoGcLocks(commonDir, { canProbePids: true })).gcPid).toBe('stale')

    await writeAged('gc.pid', `${process.pid} another-host`, 60_000)
    expect((await inspectRepoGcLocks(commonDir, { canProbePids: true })).gcPid).toBe('live')

    await writeAged('gc.pid', `${process.pid} another-host`, 13 * 60 * 60_000)
    expect((await inspectRepoGcLocks(commonDir, { canProbePids: true })).gcPid).toBe('stale')
  })

  it('trusts only age when pids belong to another kernel', async () => {
    await writeAged('gc.pid', `${DEAD_PID} ${hostname()}`, 60_000)
    expect((await inspectRepoGcLocks(commonDir, { canProbePids: false })).gcPid).toBe('live')
  })
})
