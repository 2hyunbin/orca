import { expect, it, vi } from 'vitest'
import { buildUnitDependencyGraph } from './ci-unit-dependency-graph.mjs'
import { auditUnitScenarios } from './ci-unit-selection-scenarios.mjs'

const sources = new Map([
  ['src/value.ts', 'export const value = 1'],
  ['src/value.test.ts', "import './value'"],
  ['src/indirect.test.ts', 'import(runtimePath)'],
  ['src/unrelated.test.ts', 'export const test = 1']
])
const files = [...sources.keys()].filter((file) => file.endsWith('.test.ts'))
const graph = { ...buildUnitDependencyGraph(sources), files: new Set(sources.keys()) }
const input = {
  sourceSha: 'sha',
  files,
  graph,
  scenarios: { leaf: ['src/value.ts'], global: ['pnpm-lock.yaml'] }
}
const records = files.map((file, index) => ({
  plan: {
    sourceSha: 'sha',
    mode: 'shadow',
    selectionAvailable: false,
    files,
    executionFiles: files,
    candidateFiles: files
  },
  timing: {
    sourceSha: 'sha',
    runId: '1',
    runAttempt: '1',
    nodeVersion: '24',
    status: 'failed',
    unhandledErrors: 0,
    shard: { index: index + 1, count: files.length },
    timings: { [file]: 100 },
    results: { [file]: file === 'src/unrelated.test.ts' ? 'failed' : 'passed' }
  }
}))

it('replays source-only scenarios against full fallback evidence without changing original plans', () => {
  const before = structuredClone(records)
  const [leaf, global] = auditUnitScenarios(records, input)
  expect(leaf.candidateFiles).toEqual(['src/value.test.ts', 'src/indirect.test.ts'])
  expect(leaf.references).toEqual([
    expect.objectContaining({
      completeFullRun: true,
      selectionEvaluated: true,
      missedFailures: ['src/unrelated.test.ts'],
      potentiallyOmittedWorkerMs: 100,
      measuredWorkerMs: 300
    })
  ])
  expect(global.references[0]).toMatchObject({
    completeFullRun: true,
    selectionEvaluated: false,
    potentiallyOmittedWorkerMs: 0
  })
  expect(records).toEqual(before)
})

it('keeps independent runtime references and reports a missed failure in either one', () => {
  const otherRuntime = records.map(({ plan, timing }) => ({
    plan,
    timing: {
      ...timing,
      nodeVersion: '26',
      results: { [Object.keys(timing.results)[0]]: 'passed' }
    }
  }))
  const [leaf] = auditUnitScenarios([...records, ...otherRuntime], input)
  expect(leaf.references.map((row) => [row.nodeVersion, row.missedFailures])).toEqual([
    ['24', ['src/unrelated.test.ts']],
    ['26', []]
  ])
})

it.each(
  [
    [],
    records.slice(1),
    [...records, records[0]],
    records.map((row) => ({ ...row, plan: { ...row.plan, mode: 'selected' } })),
    records.map((row) => ({ ...row, timing: { ...row.timing, unhandledErrors: 1 } })),
    records.map((row) => ({ ...row, timing: { ...row.timing, sourceSha: 'old-sha' } })),
    records.map((row) => ({ ...row, plan: { ...row.plan, sourceSha: 'old-sha' } })),
    records.map((row) => ({ ...row, plan: { ...row.plan, files: [...files, 'new.test.ts'] } })),
    records.map((row) => ({ ...row, plan: { ...row.plan, executionFiles: files.slice(1) } }))
  ].map((rows) => ({ rows }))
)('rejects stale, incomplete, selected or incompatible evidence %#', ({ rows }) => {
  const lazyGraph = vi.fn(() => graph)
  expect(() => auditUnitScenarios(rows, { ...input, graph: lazyGraph })).toThrow()
  expect(lazyGraph).not.toHaveBeenCalled()
})

it.each(
  [
    null,
    [],
    {},
    { '': [] },
    { bad: 'src/value.ts' },
    { bad: [123] },
    { bad: ['src\\value.ts'] },
    { bad: ['/src/value.ts'] },
    { bad: ['C:/src/value.ts'] },
    { bad: ['src/../value.ts'] }
  ].map((scenarios) => ({ scenarios }))
)('rejects malformed scenario inputs: %j', ({ scenarios }) => {
  expect(() => auditUnitScenarios(records, { ...input, scenarios })).toThrow('Scenarios must map')
})

it.each(
  [[], ['src/deleted.ts'], ['src/uncovered.ts'], ['src/value.ts', 'config/vitest.config.ts']].map(
    (changed) => ({ changed })
  )
)('retains full fallback for unsupported changed paths: %j', ({ changed }) => {
  const [scenario] = auditUnitScenarios(records, {
    ...input,
    scenarios: { fallback: changed }
  })
  expect(scenario.candidateFiles).toEqual(files)
  expect(scenario.references[0].selectionEvaluated).toBe(false)
})

it('collects the graph once for multiple source scenarios and skips it for global fallback', () => {
  const lazyGraph = vi.fn(() => graph)
  auditUnitScenarios(records, {
    ...input,
    graph: lazyGraph,
    scenarios: { a: ['src/value.ts'], b: ['src/value.test.ts'] }
  })
  expect(lazyGraph).toHaveBeenCalledTimes(1)
  lazyGraph.mockClear()
  auditUnitScenarios(records, {
    ...input,
    graph: lazyGraph,
    scenarios: { global: ['package.json'] }
  })
  expect(lazyGraph).not.toHaveBeenCalled()
})

it('rejects partial references from different Bun versions', () => {
  const mixed = records.map((row, index) => ({
    ...row,
    timing: { ...row.timing, bunVersion: index === 0 ? '1.2.1' : '1.3.0' }
  }))
  expect(() => auditUnitScenarios(mixed, input)).toThrow('complete full run')
})
