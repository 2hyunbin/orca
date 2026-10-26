import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isRepoMaintenanceLocked } from './repo-maintenance-locks'

let commonDir: string

beforeEach(async () => {
  commonDir = await mkdtemp(join(tmpdir(), 'orca-maintenance-locks-'))
  await mkdir(join(commonDir, 'objects'))
})

afterEach(async () => {
  await rm(commonDir, { recursive: true, force: true })
})

describe('maintenance lock inspection', () => {
  it('preserves old locks and defers until their owner removes them', async () => {
    const lock = join(commonDir, 'objects', 'maintenance.lock')
    await writeFile(lock, 'old generation')
    const old = new Date(Date.UTC(2020, 0, 1))
    await utimes(lock, old, old)
    await writeFile(join(commonDir, 'gc.pid'), '1 another-host')
    await writeFile(join(commonDir, 'gc.log.lock'), '')

    expect(await isRepoMaintenanceLocked(commonDir)).toBe(true)
    expect(await readFile(lock, 'utf8')).toBe('old generation')
    expect(await readFile(join(commonDir, 'gc.pid'), 'utf8')).toBe('1 another-host')
    expect(await readFile(join(commonDir, 'gc.log.lock'), 'utf8')).toBe('')
    await rm(lock)
    expect(await isRepoMaintenanceLocked(commonDir)).toBe(false)
  })

  it('never removes a replacement lock after inspecting an older generation', async () => {
    const lock = join(commonDir, 'objects', 'maintenance.lock')
    await writeFile(lock, 'old generation')
    const pending = isRepoMaintenanceLocked(commonDir)
    await rm(lock)
    await writeFile(lock, 'live generation')
    await pending

    expect(await readFile(lock, 'utf8')).toBe('live generation')
    expect(await isRepoMaintenanceLocked(commonDir)).toBe(true)
  })

  it('fails closed on an invalid parent path', async () => {
    const parent = join(commonDir, 'file')
    await writeFile(parent, '')
    expect(await isRepoMaintenanceLocked(parent)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('treats a dangling lock symlink as held', async () => {
    await symlink(join(commonDir, 'missing'), join(commonDir, 'objects', 'maintenance.lock'))
    expect(await isRepoMaintenanceLocked(commonDir)).toBe(true)
  })
})
