import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collectCurrentCounts,
  countGetRepoAnyHostUses,
  isScannedPath,
  main,
  prune
} from './check-get-repo-any-host-ratchet.mjs'

const BASELINE = 'config/get-repo-any-host-baseline.txt'
const roots = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function baselineRoot(baseline) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-get-repo-any-host-'))
  roots.push(root)
  mkdirSync(path.join(root, 'config'), { recursive: true })
  writeFileSync(path.join(root, BASELINE), baseline)
  return root
}

describe('countGetRepoAnyHostUses', () => {
  it('counts calls, optional calls, hand-offs and destructuring, not declarations or types', () => {
    const src = [
      'type S = { getRepoAnyHost(id: string): Repo; other: Store["getRepoAnyHost"] }',
      'type P = Pick<Store, "getRepoAnyHost">',
      'class C { getRepoAnyHost(id: string) { return this.ops.getRepoAnyHost(id) } }',
      'const a = store.getRepoAnyHost(id)',
      'const b = store?.getRepoAnyHost?.(id)',
      'const c = { getRepoAnyHost: (id) => id }',
      'const d = store["getRepoAnyHost"](id)',
      'const { getRepoAnyHost } = store',
      'const e = typeof store.getRepoAnyHost === "function"',
      '// store.getRepoAnyHost(id) in a comment',
      'const f = "getRepoAnyHost(id)"',
      'const g = store.getRepo(id, hostId)'
    ].join('\n')
    expect(countGetRepoAnyHostUses('src/main/a.ts', src)).toBe(6)
  })
})

describe('isScannedPath', () => {
  it('skips tests, specs and test helpers', () => {
    expect(isScannedPath('src/main/a.ts')).toBe(true)
    expect(isScannedPath('src/main/a.test.ts')).toBe(false)
    expect(isScannedPath('src/main/runtime/orca-runtime-tests/a.spec.ts')).toBe(false)
    expect(isScannedPath('src/main/a-test-harness.ts')).toBe(false)
    expect(isScannedPath('src/main/a.d.ts')).toBe(false)
  })
})

describe('main', () => {
  it('passes at the baseline, fails on growth or a new file, and requires lowering on shrink', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const files = new Map([
      ['src/main/a.ts', 'store.getRepoAnyHost(id)\nstore.getRepoAnyHost(id)\n'],
      ['src/main/a.test.ts', 'store.getRepoAnyHost(id)\n']
    ])
    expect(collectCurrentCounts(files)).toEqual(new Map([['src/main/a.ts', 2]]))
    expect(main(baselineRoot('2 src/main/a.ts\n'), files)).toBe(0)
    expect(main(baselineRoot('1 src/main/a.ts\n'), files)).toBe(1)
    const withNewFile = new Map([...files, ['src/main/b.ts', 'x.getRepoAnyHost(id)\n']])
    expect(main(baselineRoot('2 src/main/a.ts\n'), withNewFile)).toBe(1)

    const shrunk = new Map([['src/main/a.ts', 'store.getRepoAnyHost(id)\n']])
    const root = baselineRoot('2 src/main/a.ts # why\n')
    expect(main(root, shrunk)).toBe(1)
    prune(root, shrunk)
    expect(readFileSync(path.join(root, BASELINE), 'utf8')).toContain('1 src/main/a.ts # why')
    expect(main(root, shrunk)).toBe(0)
  })
})
