import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { runOrcadStateSnapshotOp } from './orcad-state-snapshot-host-op'
import { parseOrcadSnapshotCapture } from '../managed-server/host-state/orcad-state-snapshot'
import { orcadSnapshotFailureReason } from '../managed-server/host-state/orcad-state-snapshot-space'

const ROOT_USER = process.getuid?.() === 0
const run = async (...argv: string[]): Promise<string> =>
  (await runOrcadStateSnapshotOp(argv)).join('\n')

describe.skipIf(process.platform === 'win32')('orcad --orcad-state-snapshot capture', () => {
  let base: string
  let root: string
  let snapshots: string
  let umask: number

  beforeEach(() => {
    umask = process.umask()
    base = mkdtempSync(join(tmpdir(), 'orcad-snapshot-op-'))
    root = join(base, 'root')
    snapshots = join(base, 'snapshots')
    mkdirSync(join(root, 'profiles', 'p1'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'p1', 'profile-state.db'), 'state')
    writeFileSync(join(root, 'orca-profile-index.json'), '{}')
    mkdirSync(join(root, 'daemon'))
    writeFileSync(join(root, 'daemon', 'token'), 'live')
    for (const name of ['pre-0.1.0+aa01-1', 'pre-0.1.0+bb02-2', 'rollback-rescue-0.1.0+bb02-3']) {
      mkdirSync(join(snapshots, name), { recursive: true })
    }
  })

  afterEach(() => {
    process.umask(umask)
    chmodSync(join(root, 'profiles', 'p1'), 0o700)
    rmSync(base, { recursive: true, force: true })
  })

  it('writes a state.tar the shell tar restores, without the excluded daemon dir', async () => {
    const snapshot = join(snapshots, 'pre-0.2.0+cc03-4')
    expect(parseOrcadSnapshotCapture(await run('capture', root, snapshot))).toBe('captured')
    expect(existsSync(join(snapshot, 'state.tar.partial'))).toBe(false)

    const out = join(base, 'out')
    mkdirSync(out)
    const extracted = await runProcess({
      program: 'tar',
      args: ['-C', out, '-xf', join(snapshot, 'state.tar')]
    })
    expect(extracted.code).toBe(0)
    expect(readdirSync(out).sort()).toEqual(['orca-profile-index.json', 'profiles'])
    expect(readFileSync(join(out, 'profiles', 'p1', 'profile-state.db'), 'utf8')).toBe('state')
  })

  it('prunes earlier captures but keeps the named ones and every rollback rescue', async () => {
    const snapshot = join(snapshots, 'pre-0.2.0+cc03-4')
    const output = await run('capture', root, snapshot, 'pre-0.1.0+bb02-2')

    expect(parseOrcadSnapshotCapture(output)).toBe('captured')
    expect(readdirSync(snapshots).sort()).toEqual([
      'pre-0.1.0+bb02-2',
      'pre-0.2.0+cc03-4',
      'rollback-rescue-0.1.0+bb02-3'
    ])
  })

  it.skipIf(ROOT_USER)('still captures when an old capture cannot be pruned', async () => {
    writeFileSync(join(snapshots, 'pre-0.1.0+aa01-1', 'state.tar'), 'old')
    chmodSync(join(snapshots, 'pre-0.1.0+aa01-1'), 0o500)
    const snapshot = join(snapshots, 'pre-0.2.0+cc03-4')
    try {
      expect(parseOrcadSnapshotCapture(await run('capture', root, snapshot))).toBe('captured')
    } finally {
      chmodSync(join(snapshots, 'pre-0.1.0+aa01-1'), 0o700)
    }
  })

  it('answers EMPTY for a root that holds no member', async () => {
    const empty = join(base, 'empty')
    mkdirSync(empty)
    const snapshot = join(snapshots, 'pre-0.2.0+cc03-4')
    expect(parseOrcadSnapshotCapture(await run('capture', empty, snapshot))).toBe('empty')
    expect(existsSync(snapshot)).toBe(false)
  })

  it('refuses a member holding a symbolic link, and says which', async () => {
    symlinkSync('/etc/passwd', join(root, 'profiles', 'p1', 'escape'))
    const output = await run('capture', root, join(snapshots, 'pre-0.2.0+cc03-4'))

    expect(parseOrcadSnapshotCapture(output)).toBe('failed')
    expect(orcadSnapshotFailureReason(output)).toMatch(/profiles holds a symbolic link.*escape/u)
  })

  it.skipIf(ROOT_USER)('removes its partial archive and says why when the copy fails', async () => {
    writeFileSync(join(root, 'profiles', 'p1', 'locked'), 'secret')
    chmodSync(join(root, 'profiles', 'p1', 'locked'), 0o000)
    const snapshot = join(snapshots, 'pre-0.2.0+cc03-4')

    const output = await run('capture', root, snapshot)

    expect(parseOrcadSnapshotCapture(output)).toBe('failed')
    expect(orcadSnapshotFailureReason(output)).toMatch(/Permission denied|Cannot open/u)
    expect(existsSync(snapshot)).toBe(false)
  })

  it('fails an op it does not know, so an unknown verdict is never read as success', async () => {
    expect(parseOrcadSnapshotCapture(await run('restore', root, base))).toBe('failed')
  })
})
