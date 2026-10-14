import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

// git show <ref>:src/renderer/src/components/sidebar/host-section-rows.ts | node config/scripts/host-section-header-scan-benchmark.mjs
const file = 'src/renderer/src/components/sidebar/host-section-rows.ts'
const sources = {
  before: readFileSync(process.argv[2] ?? 0, 'utf8'),
  after: readFileSync(file, 'utf8')
}
async function load(sourceFile, contents) {
  const bundle = await build({
    stdin: {
      contents,
      loader: 'ts',
      resolveDir: dirname(resolve(sourceFile)),
      sourcefile: sourceFile
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    tsconfig: 'config/tsconfig.web.json',
    logLevel: 'silent',
    define: {
      'import.meta.env': '{}',
      ORCA_FEATURE_WALL_ENABLED: 'true',
      ORCA_BUILD_COMMIT: '"performance-benchmark"'
    }
  })
  return await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  )
}
const implementations = {
  before: (await load(file, sources.before)).addHostSectionRows,
  after: (await load(file, sources.after)).addHostSectionRows
}
const rowFile = 'src/renderer/src/components/sidebar/worktree-list/grouping/build-rows.ts'
const { buildRows } = await load(rowFile, readFileSync(rowFile, 'utf8'))
const hostOptions = [
  { id: 'local', kind: 'local', label: 'Local', detail: '', health: 'local' },
  { id: 'ssh:builder', kind: 'ssh', label: 'Builder', detail: '', health: 'available' },
  { id: 'runtime:builder', kind: 'runtime', label: 'Builder', detail: '', health: 'available' }
]
function fixture(count, lane, hostCount = 2, prefix = 'workspace') {
  const repos = hostOptions.slice(0, hostCount).map((host, index) => ({
    id: `repo-${index}`,
    path: `/benchmark/repo-${index}`,
    displayName: `Repo ${index}`,
    addedAt: 1,
    executionHostId: host.id
  }))
  const worktrees = Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    instanceId: `${prefix}-${index}`,
    repoId: repos[index % hostCount].id,
    hostId: repos[index % hostCount].executionHostId,
    displayName: `${prefix}-${index}`,
    path: `/benchmark/${prefix}-${index}`,
    branch: 'refs/heads/topic',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    comment: '',
    isUnread: false,
    isPinned: lane === 'pinned',
    sortOrder: index,
    lastActivityAt: index
  }))
  const rows = buildRows(
    lane === 'pinned' ? 'none' : lane,
    worktrees,
    new Map(repos.map((repo) => [repo.id, repo])),
    null,
    new Set()
  )
  return {
    rows,
    hostOptions: hostOptions.slice(0, hostCount),
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: hostOptions.slice(0, hostCount).map((host) => host.id),
    defaultHostId: 'local',
    preferProjectGrouping: true
  }
}
function verify(input) {
  const before = implementations.before(input)
  const after = implementations.after(input)
  assert.deepEqual(after, before)
  return before
}
const boundary = fixture(20, 'none')
verify({ ...boundary, rows: [...boundary.rows, ...boundary.rows] })
verify({ ...boundary, rows: [...boundary.rows, ...fixture(20, 'none', 2, 'later').rows] })
verify({ ...boundary, collapsedHostKeys: new Set(['host:ssh:builder']) })
verify({ ...boundary, forceCollapseHosts: true })
verify({ ...boundary, visibleWorkspaceHostIds: null })
verify({ ...boundary, workspaceHostScope: 'local', visibleWorkspaceHostIds: ['local'] })
let differentialCases = 6
for (const lane of ['none', 'pinned', 'workspace-status', 'pr-status']) {
  for (const count of [0, 1, 2, 7, 25, 100]) {
    for (const hostCount of [2, 3]) {
      verify(fixture(count, lane, hostCount))
      differentialCases += 1
    }
  }
}

const countInput = fixture(100, 'none')
const header = countInput.rows.find((row) => row.type === 'header' && row.key === 'all')
assert.ok(header?.hostWorktreeCounts)
const counts = header.hostWorktreeCounts
const reads = {}
for (const arm of ['before', 'after']) {
  let calls = 0
  const nativeGet = counts.get
  counts.get = function (hostId) {
    calls += 1
    return nativeGet.call(this, hostId)
  }
  try {
    implementations[arm](countInput)
  } finally {
    counts.get = nativeGet
  }
  reads[arm] = calls
}
assert.equal(reads.before, 100)
assert.equal(reads.after, 2)

const results = []
for (const count of [2, 20, 100, 500, 1000, 2000, 5000]) {
  for (const lane of ['none', 'workspace-status']) {
    const input = fixture(count, lane)
    const expected = verify(input)
    const iterations = count < 100 ? 100 : count <= 1000 ? 10 : 1
    const samples = { before: [], after: [] }
    function measure(arm) {
      let result
      const started = performance.now()
      for (let repeat = 0; repeat < iterations; repeat += 1) {
        result = implementations[arm](input)
      }
      const elapsed = (performance.now() - started) / iterations
      assert.deepEqual(result, expected)
      return elapsed
    }
    for (const pair of buildCounterbalancedSchedule(4, 'before', 'after')) {
      for (const arm of pair) {
        measure(arm)
      }
    }
    for (const pair of buildCounterbalancedSchedule(12, 'before', 'after')) {
      for (const arm of pair) {
        samples[arm].push(measure(arm))
      }
    }
    results.push({
      workspaces: count,
      lane,
      iterations,
      beforeMicroseconds: summarizeBenchmarkSamples(samples.before.map((ms) => ms * 1000)),
      afterMicroseconds: summarizeBenchmarkSamples(samples.after.map((ms) => ms * 1000)),
      rawSamplesMs: samples
    })
  }
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      sourceSha256: Object.fromEntries(
        Object.entries(sources).map(([arm, source]) => [
          arm,
          createHash('sha256').update(source).digest('hex')
        ])
      ),
      differentialCases,
      localizationMapReads: reads,
      results
    },
    null,
    2
  )
)
