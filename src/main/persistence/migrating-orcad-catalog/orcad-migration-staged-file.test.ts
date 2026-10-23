import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { orcadMigrationFileMatches } from './orcad-migration-staged-file'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orcad-migration-digest-'))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

it.each([0, 256 * 1024 - 1, 256 * 1024, 256 * 1024 + 1, 512 * 1024 + 7])(
  'verifies all %i bytes, including a partial final chunk',
  (byteLength) => {
    const path = join(root, 'staged')
    const bytes = Buffer.alloc(byteLength, 0x78)
    const expected = {
      byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
    writeFileSync(path, bytes)
    expect(orcadMigrationFileMatches(path, expected)).toBe(true)
    expect(orcadMigrationFileMatches(path, { ...expected, byteLength: byteLength + 1 })).toBe(false)
    expect(orcadMigrationFileMatches(path, { ...expected, sha256: '0'.repeat(64) })).toBe(false)
    if (byteLength > 0) {
      bytes[byteLength - 1] ^= 1
      writeFileSync(path, bytes)
      expect(orcadMigrationFileMatches(path, expected)).toBe(false)
    }
  }
)

it('refuses missing files and directories', () => {
  const expected = { byteLength: 0, sha256: createHash('sha256').digest('hex') }
  expect(orcadMigrationFileMatches(join(root, 'missing'), expected)).toBe(false)
  expect(orcadMigrationFileMatches(root, expected)).toBe(false)
})
