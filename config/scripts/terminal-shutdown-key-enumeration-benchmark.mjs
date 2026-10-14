#!/usr/bin/env node
// Run: node config/scripts/terminal-shutdown-key-enumeration-benchmark.mjs baseline-source.ts
// Alternatively pipe the saved baseline source on stdin. No Electron app is launched.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import {
  BENCHMARK_SAMPLE_AGGREGATION,
  summarizeBenchmarkSamples
} from './benchmark-sample-summary.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const renderer = path.join(repoRoot, 'src/renderer/src')
const entry = path.join(renderer, 'store/terminals/terminal-shutdown-state.ts')
const sources = {
  before: readFileSync(process.argv[2] ?? 0, 'utf8'),
  after: readFileSync(entry, 'utf8')
}
for (const source of Object.values(sources)) {
  assert(source.includes('export function commitTerminalShutdownState'), 'Expected reducer source')
}

async function load(source) {
  const result = await build({
    stdin: { contents: source, resolveDir: path.dirname(entry), sourcefile: entry, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    minify: true,
    alias: { '@': renderer },
    define: {
      'import.meta.env': '{}',
      ORCA_FEATURE_WALL_ENABLED: 'true',
      ORCA_BUILD_COMMIT: '"performance-benchmark"'
    }
  })
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
  return module.commitTerminalShutdownState
}
const reducers = Object.fromEntries(
  await Promise.all(Object.entries(sources).map(async ([arm, source]) => [arm, await load(source)]))
)
const paneFields = [
  'unreadTerminalPanes',
  'unreadAgentCompletionPanes',
  'lastTerminalInputAtByPaneKey'
]
const referenceFields = [
  'tabsByWorktree',
  'ptyIdsByTabId',
  'suppressedPtyExitIds',
  'pendingPtyShutdownIds',
  'pendingCodexPaneRestartIds',
  'codexRestartNoticeByPtyId',
  'pendingSetupSplitByTabId',
  'pendingIssueCommandSplitByTabId',
  'terminalLayoutsByTabId',
  'runtimePaneTitlesByTabId',
  'lastKnownRelayPtyIdByTabId',
  'unreadTerminalTabs',
  ...paneFields
]

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freeze(child)
    }
    Object.freeze(value)
  }
  return value
}

function fixture(tabCount, paneCount, matchingKeys) {
  const tabs = Array.from({ length: tabCount }, (_, index) => ({
    id: `shutdown-tab-${index}`,
    worktreeId: 'worktree',
    ptyId: null,
    title: 'Shell',
    customTitle: null,
    color: null,
    sortOrder: index,
    createdAt: 100
  }))
  const state = {
    tabsByWorktree: { worktree: tabs },
    ptyIdsByTabId: Object.fromEntries(tabs.map((tab) => [tab.id, []])),
    suppressedPtyExitIds: {},
    pendingPtyShutdownIds: {},
    pendingCodexPaneRestartIds: {},
    codexRestartNoticeByPtyId: {},
    pendingSetupSplitByTabId: {},
    pendingIssueCommandSplitByTabId: {},
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    unreadAgentCompletionPanes: {},
    lastTerminalInputAtByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    dropAgentStatusByWorktree: () => {},
    clearPaneForegroundAgentByWorktree: () => {},
    clearSleepingAgentSessionsByWorktree: () => {},
    isPtyShutdownPending: () => false
  }
  for (let index = 0; index < paneCount; index++) {
    const prefix = matchingKeys && index < tabCount * 2 ? 'shutdown-tab' : 'other-tab'
    const key = `${prefix}-${Math.floor(index / 2)}:${index % 2}`
    state.unreadTerminalPanes[key] = true
    state.unreadAgentCompletionPanes[key] = true
    state.lastTerminalInputAtByPaneKey[key] = 100 + index
  }
  return freeze({ state, tabs })
}

function commit(reducer, input) {
  let current = input.state
  reducer({
    exitGuardPtyIds: [],
    get: () => current,
    keepIdentifiers: true,
    retainedCompletionEvidence: [],
    set: (update) => {
      const patch = typeof update === 'function' ? update(current) : update
      current = { ...current, ...patch }
    },
    shutdownReason: 'manual-sleep',
    sleepingAgentSessionRecords: {},
    tabs: input.tabs,
    worktreeId: 'worktree'
  })
  return current
}

function verify(input, matchingKeys) {
  const outputs = {}
  const enumerations = {}
  const originalKeys = Object.keys
  for (const [arm, reducer] of Object.entries(reducers)) {
    const counts = Object.fromEntries(paneFields.map((field) => [field, 0]))
    Object.keys = (record) => {
      for (const field of paneFields) {
        if (record === input.state[field]) {
          counts[field]++
        }
      }
      return originalKeys(record)
    }
    try {
      outputs[arm] = commit(reducer, input)
    } finally {
      Object.keys = originalKeys
    }
    enumerations[arm] = counts
  }
  assert.deepEqual(outputs.after, outputs.before)
  for (const field of referenceFields) {
    const retainedBefore = outputs.before[field] === input.state[field]
    const retainedAfter = outputs.after[field] === input.state[field]
    assert.equal(retainedAfter, retainedBefore, `${field}: reference parity`)
    const shouldChange = matchingKeys && input.tabs.length > 0 && paneFields.includes(field)
    assert.equal(retainedAfter, !shouldChange, `${field}: expected retained reference`)
  }
  for (const field of paneFields) {
    assert.equal(enumerations.before[field], input.tabs.length, `${field}: baseline key scans`)
    assert.equal(
      enumerations.after[field],
      input.tabs.length === 0 ? 0 : 1,
      `${field}: new key scans`
    )
  }
  return enumerations
}

let sink = 0
function sample(reducer, input, iterations) {
  let output
  const startedAt = performance.now()
  for (let index = 0; index < iterations; index++) {
    output = commit(reducer, input)
  }
  const elapsedMs = performance.now() - startedAt
  sink += Object.keys(output.lastTerminalInputAtByPaneKey).length
  return elapsedMs / iterations
}

const schedule = buildCounterbalancedSchedule(8, 'before', 'after')
const results = []
for (const [tabs, panes, iterations] of [
  [0, 100, 100],
  [1, 100, 100],
  [10, 1000, 40],
  [50, 5000, 5],
  [100, 5000, 5],
  [200, 20000, 1]
]) {
  for (const matchingKeys of [false, true]) {
    const input = fixture(tabs, panes, matchingKeys)
    const keyEnumerations = verify(input, matchingKeys)
    for (let index = 0; index < 3; index++) {
      commit(reducers.before, input)
      commit(reducers.after, input)
    }
    const rawSamplesMs = { before: [], after: [] }
    for (const pair of schedule) {
      for (const arm of pair) {
        rawSamplesMs[arm].push(sample(reducers[arm], input, iterations))
      }
    }
    const row = {
      tabs,
      paneKeysPerRecord: panes,
      matchingKeys,
      iterationsPerSample: iterations,
      outputParity: true,
      referenceParity: true,
      frozenSourceInputs: true,
      keyEnumerations,
      summary: Object.fromEntries(
        Object.entries(rawSamplesMs).map(([arm, samples]) => [
          arm,
          summarizeBenchmarkSamples(samples)
        ])
      ),
      rawSamplesMs
    }
    results.push(row)
    console.error(JSON.stringify({ tabs, panes, matchingKeys, summary: row.summary }))
  }
}
console.log(
  JSON.stringify(
    {
      benchmark: 'terminal-shutdown-key-enumeration',
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      measurement: 'Full production reducer self-time per call; not packaged-app frame latency',
      baselineDependencies: 'Both entry sources bundle unchanged dependencies from this checkout',
      sourceSha256: Object.fromEntries(
        Object.entries(sources).map(([arm, source]) => [
          arm,
          createHash('sha256').update(source).digest('hex')
        ])
      ),
      aggregation: BENCHMARK_SAMPLE_AGGREGATION,
      schedule,
      results,
      sink
    },
    null,
    2
  )
)
