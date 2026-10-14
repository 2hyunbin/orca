#!/usr/bin/env node
import { deepStrictEqual } from 'node:assert'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createJiti } from 'jiti'

const baselinePath = process.argv[2]
if (!baselinePath) {
  throw new Error(
    'Usage: node config/scripts/headless-restored-link-scan-benchmark.mjs BASELINE_FILE.ts'
  )
}
const baseline = resolve(baselinePath)
const beforeJiti = createJiti(import.meta.url, {
  fsCache: false,
  moduleCache: false,
  alias: { './headless-osc-link-ranges': baseline }
})
const afterJiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false })
const { collectHeadlessOscLinkRanges: before } = await beforeJiti.import(baseline)
const { collectHeadlessOscLinkRanges: after } = await afterJiti.import(
  '../../src/main/daemon/headless-osc-link-ranges.ts'
)
const { HeadlessEmulator: BeforeEmulator } = await beforeJiti.import(
  '../../src/main/daemon/headless-emulator.ts'
)
const { HeadlessEmulator: AfterEmulator } = await afterJiti.import(
  '../../src/main/daemon/headless-emulator.ts'
)

class ObservableBefore extends BeforeEmulator {
  getTerminal() {
    return this.terminal
  }
}
class ObservableAfter extends AfterEmulator {
  getTerminal() {
    return this.terminal
  }
}

function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]
}

let checksum = 0
function measure(operation, repetitions) {
  const start = performance.now()
  for (let index = 0; index < repetitions; index++) {
    checksum += operation()
  }
  return performance.now() - start
}

function pairedSamples(beforeOperation, afterOperation, repetitions) {
  const beforeSamples = []
  const afterSamples = []
  for (let sample = 0; sample < 20; sample++) {
    if (sample % 2 === 0) {
      beforeSamples.push(measure(beforeOperation, repetitions))
      afterSamples.push(measure(afterOperation, repetitions))
    } else {
      afterSamples.push(measure(afterOperation, repetitions))
      beforeSamples.push(measure(beforeOperation, repetitions))
    }
  }
  return { beforeMs: median(beforeSamples), afterMs: median(afterSamples) }
}

function countSnapshotRows(emulator) {
  const buffer = emulator.getTerminal().buffer.active
  const original = buffer.getLine
  let reads = 0
  buffer.getLine = function (...args) {
    reads++
    return original.apply(this, args)
  }
  try {
    emulator.getSnapshot()
    return reads
  } finally {
    buffer.getLine = original
  }
}

const results = []
for (const scrollback of [0, 1000, 5000]) {
  for (const linkState of ['saved-links', 'no-links', 'live-links']) {
    const opts = { cols: 120, rows: 24, scrollback }
    const beforeEmulator = new ObservableBefore(opts)
    const afterEmulator = new ObservableAfter(opts)
    try {
      const lineCount = scrollback + 24
      const plain = Array.from({ length: lineCount - 1 }, (_, index) => `row ${index}\r\n`).join('')
      const text =
        linkState === 'live-links'
          ? `${plain}\x1b]8;;https://example.com/live\x1b\\LIVE\x1b]8;;\x1b\\`
          : plain
      const restored =
        linkState === 'saved-links'
          ? [{ row: 0, startCol: 0, endCol: 4, uri: 'https://example.com/restored' }]
          : []
      await beforeEmulator.write(text)
      await afterEmulator.write(text)
      beforeEmulator.setRestoredOscLinks(restored)
      afterEmulator.setRestoredOscLinks(restored)
      const terminal = afterEmulator.getTerminal()
      deepStrictEqual(before(terminal, undefined, restored), after(terminal, undefined, restored))
      deepStrictEqual(beforeEmulator.getSnapshot(), afterEmulator.getSnapshot())

      const beforeRowReads = countSnapshotRows(beforeEmulator)
      const afterRowReads = countSnapshotRows(afterEmulator)
      const expectedDifference = linkState === 'saved-links' ? terminal.buffer.active.length : 0
      if (beforeRowReads - afterRowReads !== expectedDifference) {
        throw new Error(`Baseline substitution failed for ${linkState} at ${scrollback} rows`)
      }

      const collectorCalls = scrollback === 0 ? 1000 : 20
      const snapshotCalls = scrollback === 0 ? 100 : 10
      const collectBefore = () => before(terminal, undefined, restored).length
      const collectAfter = () => after(terminal, undefined, restored).length
      const snapshotBefore = () => beforeEmulator.getSnapshot().snapshotAnsi.length
      const snapshotAfter = () => afterEmulator.getSnapshot().snapshotAnsi.length
      for (let warmup = 0; warmup < 5; warmup++) {
        measure(collectBefore, collectorCalls)
        measure(collectAfter, collectorCalls)
        measure(snapshotBefore, snapshotCalls)
        measure(snapshotAfter, snapshotCalls)
      }
      const collectors = pairedSamples(collectBefore, collectAfter, collectorCalls)
      const snapshots = pairedSamples(snapshotBefore, snapshotAfter, snapshotCalls)
      const snapshot = JSON.stringify(afterEmulator.getSnapshot())
      results.push({
        linkState,
        rows: terminal.buffer.active.length,
        cells: terminal.buffer.active.length * terminal.cols,
        collectorCalls,
        beforeCollectorMs: collectors.beforeMs,
        afterCollectorMs: collectors.afterMs,
        beforeSnapshotMsPerCall: snapshots.beforeMs / snapshotCalls,
        afterSnapshotMsPerCall: snapshots.afterMs / snapshotCalls,
        beforeRowReads,
        afterRowReads,
        snapshotHash: createHash('sha256').update(snapshot).digest('hex')
      })
    } finally {
      beforeEmulator.dispose()
      afterEmulator.dispose()
    }
  }
}
console.log(
  JSON.stringify(
    { runtime: process.version, platform: process.platform, arch: process.arch, results, checksum },
    null,
    2
  )
)
