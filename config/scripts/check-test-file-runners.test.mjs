import { describe, expect, it } from 'vitest'
import { findRunnerDrift, findUncollectedTestFiles } from './check-test-file-runners.mjs'

const RUNNERS = [{ name: 'unit', include: ['src/**/*.test.ts'] }]
const SUITE = "import { it } from 'vitest'\nit('works', () => {})\n"

describe('findUncollectedTestFiles', () => {
  it('reports test files no runner include matches, whatever their naming', () => {
    const sources = new Map([
      ['src/a.test.ts', SUITE],
      ['src/orphan.spec.tsx', SUITE],
      ['src/budget.bench.ts', SUITE],
      ['tools/lease-check.mjs', "import { test } from 'node:test'\ntest('holds', () => {})\n"],
      ['src/not-a-test.ts', 'export const value = 1\n']
    ])
    expect(findUncollectedTestFiles(sources, RUNNERS)).toEqual([
      'src/orphan.spec.tsx',
      'src/budget.bench.ts',
      'tools/lease-check.mjs'
    ])
  })

  it('counts a suite module as collected only while a collected entry imports it', () => {
    const sources = new Map([
      ['src/page.test.ts', "import './page.case.spec'\n"],
      ['src/page.case.spec.ts', `import './page-harness.spec'\n${SUITE}`],
      ['src/page-harness.spec.ts', 'export const harness = {}\n'],
      ['src/page.dropped.spec.ts', `import './page-harness.spec'\n${SUITE}`]
    ])
    expect(findUncollectedTestFiles(sources, RUNNERS)).toEqual(['src/page.dropped.spec.ts'])
  })
})

describe('findRunnerDrift', () => {
  it('reports a runner whose config no longer contains the include it mirrors', () => {
    const runners = [
      { name: 'kept', source: 'a.config.ts', mirrors: ["'src/**/*.test.ts'"] },
      { name: 'changed', source: 'b.config.ts', mirrors: ["'src/**/*.test.ts'"] },
      { name: 'deleted', source: 'c.config.ts', mirrors: ['x'] }
    ]
    const files = {
      'a.config.ts': "include: ['src/**/*.test.ts']",
      'b.config.ts': "include: ['src/**/*.spec.ts']"
    }
    expect(findRunnerDrift(runners, (file) => files[file] ?? null)).toEqual([
      `changed: b.config.ts no longer contains "'src/**/*.test.ts'"`,
      `deleted: c.config.ts no longer contains "x"`
    ])
  })
})
