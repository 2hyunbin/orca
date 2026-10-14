import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

const baselinePath = process.argv[2]
assert.ok(
  baselinePath,
  'Usage: node config/scripts/task-page-dialog-cache-benchmark.mjs <saved-baseline-source.ts>'
)
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const entry = join(repositoryRoot, 'src/renderer/src/components/task-page-cache-selectors.ts')
const [baselineSource, currentSource] = await Promise.all([
  readFile(resolve(baselinePath), 'utf8'),
  readFile(entry, 'utf8')
])
async function load(contents) {
  const result = await build({
    stdin: { contents, loader: 'ts', resolveDir: dirname(entry) },
    tsconfig: join(repositoryRoot, 'config/tsconfig.web.json'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent'
  })
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    )
  ).findTaskPageDialogWorkItem
}
const lookups = { before: await load(baselineSource), after: await load(currentSource) }
const publications = 40
const warmupPairs = 4
const schedule = buildCounterbalancedSchedule(12, 'before', 'after')

function fixture(cacheEntries, itemsPerEntry, onRead) {
  const cache = Object.fromEntries(
    Array.from({ length: cacheEntries }, (_, repo) => [
      `source-${repo}`,
      {
        fetchedAt: 1,
        data: Array.from({ length: itemsPerEntry }, (_, index) => {
          const id = `issue:${index}`
          const item = {
            id,
            repoId: `repo-${repo}`,
            type: 'issue',
            number: index,
            title: `Task ${index}`,
            state: 'open',
            url: `https://github.com/owner-${repo}/project/issues/${index}`,
            labels: [],
            updatedAt: '2026-10-13T00:00:00Z',
            author: null
          }
          return onRead ? Object.defineProperty(item, 'id', { get: () => (onRead(), id) }) : item
        })
      }
    ])
  )
  const target = cache[`source-${cacheEntries - 1}`].data.at(-1)
  const key = {
    id: `issue:${itemsPerEntry - 1}`,
    repoId: target.repoId,
    url: target.url
  }
  return { cache, target, key }
}

const operationControls = []
for (const mode of ['warm-hit', 'warm-miss', 'fresh-snapshot']) {
  const reads = {}
  for (const [arm, lookup] of Object.entries(lookups)) {
    let count = 0
    const test = fixture(20, 100, () => count++)
    const key = mode === 'warm-miss' ? { ...test.key, id: 'issue:missing' } : test.key
    for (let index = 0; index < publications; index++) {
      const cache = mode === 'fresh-snapshot' ? { ...test.cache } : test.cache
      assert.equal(lookup(cache, { ...key }), mode === 'warm-miss' ? null : test.target)
    }
    const expected = arm === 'after' && mode !== 'fresh-snapshot' ? 2_000 : 80_000
    assert.equal(count, expected, `${arm} ${mode} item-ID reads`)
    reads[arm] = count
  }
  operationControls.push({ mode, items: 2_000, reads })
}

for (const lookup of Object.values(lookups)) {
  const test = fixture(2, 2)
  assert.equal(lookup(test.cache, test.key), test.target)
  const patched = { ...test.target, title: 'Immediate optimistic edit' }
  const changed = { ...test.cache, 'source-1': { fetchedAt: 2, data: [patched] } }
  assert.equal(lookup(changed, { ...test.key }), patched)
  assert.equal(lookup({}, test.key), null)
  const first = test.cache['source-0'].data[0]
  assert.equal(lookup(test.cache, { id: first.id, repoId: first.repoId, url: first.url }), first)
}

function summarizeMs(samples) {
  // Scale to retain 0.1 microsecond precision with the shared aggregation rules.
  const summary = summarizeBenchmarkSamples(samples.map((ms) => ms * 1_000))
  return Object.fromEntries(
    Object.entries(summary).map(([key, value]) => [
      key,
      key.endsWith('Ms') ? Number((value / 1_000).toFixed(4)) : value
    ])
  )
}

const scenarios = []
for (const [cacheEntries, itemsPerEntry] of [
  [20, 50],
  [200, 100],
  [500, 200]
]) {
  const test = fixture(cacheEntries, itemsPerEntry)
  for (const mode of ['warm-hit', 'warm-miss', 'fresh-snapshot']) {
    const key = mode === 'warm-miss' ? { ...test.key, id: 'issue:missing' } : test.key
    const expected = mode === 'warm-miss' ? null : test.target
    const keys = Array.from({ length: publications }, () => ({ ...key }))
    const samples = { before: [], after: [] }
    function run(arm) {
      const caches = Array.from({ length: publications }, () =>
        mode === 'fresh-snapshot' ? { ...test.cache } : test.cache
      )
      assert.equal(lookups[arm](test.cache, key), expected)
      let matches = 0
      const started = performance.now()
      for (let index = 0; index < publications; index++) {
        matches += lookups[arm](caches[index], keys[index]) === expected ? 1 : 0
      }
      const elapsed = performance.now() - started
      assert.equal(matches, publications)
      return elapsed
    }
    for (const pair of buildCounterbalancedSchedule(warmupPairs, 'before', 'after')) {
      for (const arm of pair) {
        run(arm)
      }
    }
    for (const pair of schedule) {
      for (const arm of pair) {
        samples[arm].push(run(arm))
      }
    }
    scenarios.push({
      mode,
      cacheEntries,
      itemsPerEntry,
      totalItems: cacheEntries * itemsPerEntry,
      before: summarizeMs(samples.before),
      after: summarizeMs(samples.after),
      samplesMs: samples
    })
  }
}
const digest = (source) => createHash('sha256').update(source).digest('hex')
console.log(
  JSON.stringify(
    {
      baselinePath: resolve(baselinePath),
      sourceSha256: { before: digest(baselineSource), after: digest(currentSource) },
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      publications,
      warmupPairs,
      schedule,
      scope:
        'Bundled production selector plus loop/result checks; fixture creation and warm priming excluded. Instrumented read counts are separate from timings. No app typing or frame-latency claim.',
      operationControls,
      scenarios
    },
    null,
    2
  )
)
