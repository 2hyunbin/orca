#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createJiti } from 'jiti'

// Pass the pre-change production module as argv[2]; both sides run real production code.
const baselinePath = process.argv[2]
if (!baselinePath) {
  throw new Error(
    'Usage: node config/scripts/terminal-cursor-show-scan-benchmark.mjs BASELINE_FILE.ts'
  )
}
const jiti = createJiti(import.meta.url)
const { removeTransientCursorShowSequences: before } = await jiti.import(resolve(baselinePath))
const { removeTransientCursorShowSequences: after } = await jiti.import(
  '../../src/renderer/src/lib/pane-manager/pane-terminal-cursor-sequencing.ts'
)
const fixtureRoot = new URL('../../src/main/runtime/__fixtures__/', import.meta.url)
const fixtureNames = new Set(readdirSync(fixtureRoot))
const captures = []
let parityChecks = 0

for (const name of fixtureNames) {
  if (!name.endsWith('.txt')) {
    continue
  }
  const data = readFileSync(new URL(name, fixtureRoot), 'utf8')
  if (!data.includes('\x1b[?25h')) {
    continue
  }
  const timingName = name.replace('.txt', '.timing.json')
  let chunks
  if (fixtureNames.has(timingName)) {
    const timing = JSON.parse(readFileSync(new URL(timingName, fixtureRoot), 'utf8'))
    let offset = 0
    chunks = timing.chunks.map(([, length]) => {
      const chunk = data.slice(offset, offset + length)
      offset += length
      return chunk
    })
    if (offset !== data.length) {
      throw new Error(`${name}: timing lengths ${offset} != capture length ${data.length}`)
    }
  } else {
    chunks = Array.from({ length: Math.ceil(data.length / 16384) }, (_, index) =>
      data.slice(index * 16384, (index + 1) * 16384)
    )
  }
  for (const chunk of [data, ...chunks]) {
    if (before(chunk) !== after(chunk)) {
      throw new Error(`${name}: output parity failed`)
    }
    parityChecks++
  }
  captures.push({ name, chunks })
}

let checksum = 0
function time(rewrite, chunks, repetitions) {
  const start = performance.now()
  for (let index = 0; index < repetitions; index++) {
    for (const chunk of chunks) {
      checksum += rewrite(chunk).length
    }
  }
  return performance.now() - start
}

function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]
}

function benchmark(label, chunks, repetitions) {
  for (let index = 0; index < 3; index++) {
    time(before, chunks, repetitions)
    time(after, chunks, repetitions)
  }
  const beforeSamples = []
  const afterSamples = []
  for (let index = 0; index < 12; index++) {
    if (index % 2 === 0) {
      beforeSamples.push(time(before, chunks, repetitions))
      afterSamples.push(time(after, chunks, repetitions))
    } else {
      afterSamples.push(time(after, chunks, repetitions))
      beforeSamples.push(time(before, chunks, repetitions))
    }
  }
  const beforeMs = median(beforeSamples)
  const afterMs = median(afterSamples)
  return {
    label,
    chunks: chunks.length,
    chars: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    repetitions,
    beforeMs,
    afterMs,
    speedup: beforeMs / afterMs
  }
}

const coloredBody = '\x1b[31mred\x1b[0m'.repeat(1000)
const repeatedShows = `${'\x1b[?25h'.repeat(32)}${coloredBody}\x1b[?25l`
const results = [
  benchmark(
    'Captured agent output, original PTY sizes when available; 16 KiB otherwise',
    captures.flatMap(({ chunks }) => chunks),
    200
  ),
  benchmark('12 KiB ANSI-heavy redraw, 32 shows before hide (adverse)', [repeatedShows], 200),
  benchmark('Ordinary keystroke echo', ['x'], 1000000),
  benchmark('12 KiB colored output without a cursor show', [coloredBody], 10000)
]
console.log(
  JSON.stringify(
    {
      runtime: process.version,
      platform: process.platform,
      arch: process.arch,
      captures: captures.length,
      parityChecks,
      results,
      checksum
    },
    null,
    2
  )
)
