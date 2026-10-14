#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { arch, cpus, platform } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Save the pre-change ssh-channel-multiplexer.ts with git show and pass its path.
const baselinePath = process.argv[2]
if (!baselinePath) {
  throw new Error('Usage: node config/scripts/ssh-ack-backlog-benchmark.mjs BASELINE.ts')
}
const entry = fileURLToPath(
  new URL('../../src/main/ssh/ssh-channel-multiplexer.ts', import.meta.url)
)
const sources = [readFileSync(baselinePath, 'utf8'), readFileSync(entry, 'utf8')]
const iterations = 24
const warmups = 6

async function load(source) {
  assert(source.includes('export class SshChannelMultiplexer'))
  const result = await build({
    stdin: {
      contents: `${source}\nexport { encodeJsonRpcFrame, FRAME_DECODER_MAX_FRAMES_PER_TURN } from './relay-protocol'`,
      loader: 'ts',
      resolveDir: path.dirname(entry),
      sourcefile: entry
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
}

const modules = await Promise.all(sources.map(load))
assert.equal(
  modules[0].FRAME_DECODER_MAX_FRAMES_PER_TURN,
  modules[1].FRAME_DECODER_MAX_FRAMES_PER_TURN
)

function prepare(module, count, expected, validateBacklog) {
  let receive
  const mux = new module.SshChannelMultiplexer({
    write() {},
    onData(callback) {
      receive = callback
    },
    onClose() {}
  })
  let complete
  let fail
  const finished = new Promise((resolve, reject) => {
    complete = resolve
    fail = reject
  })
  const seen = []
  try {
    assert.equal(typeof receive, 'function')
    assert(mux.unackedTimestamps instanceof Map)
    for (let seq = 1; seq <= count; seq++) {
      mux.notify('pty.ackData', { acknowledgements: [] })
    }
    assert.deepEqual(
      [...mux.unackedTimestamps.keys()],
      expected.map(({ params }) => params.seq)
    )
    mux.onDispose(() => fail(new Error('Multiplexer disposed before the burst finished')))
    mux.onNotification((method, params) => {
      seen.push({ method, params })
      if (validateBacklog) {
        try {
          assert.deepEqual(
            [...mux.unackedTimestamps.keys()],
            expected.slice(seen.length).map(({ params: remaining }) => remaining.seq)
          )
        } catch (error) {
          fail(error)
        }
      }
      if (seen.length === count) {
        complete()
      }
    })
  } catch (error) {
    mux.dispose()
    throw error
  }
  return async (frames) => {
    const timeout = setTimeout(
      () => fail(new Error('Burst did not finish within 10 seconds')),
      10_000
    )
    try {
      const start = performance.now()
      receive(frames)
      await finished
      const elapsed = performance.now() - start
      assert.deepEqual(seen, expected)
      assert.equal(mux.unackedTimestamps.size, 0)
      assert.equal(mux.isDisposed(), false)
      return elapsed
    } finally {
      clearTimeout(timeout)
      mux.dispose()
    }
  }
}

function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]
}

const results = []
for (const count of [32, 256, 1024, 4095]) {
  const expected = Array.from({ length: count }, (_, index) => ({
    method: 'pty.data',
    params: { id: 'remote-pane', data: 'terminal output '.repeat(8), seq: index + 1 }
  }))
  const frames = Buffer.concat(
    expected.map(({ method, params }) =>
      modules[1].encodeJsonRpcFrame({ jsonrpc: '2.0', method, params }, params.seq, params.seq)
    )
  )
  // Check every intermediate ACK backlog outside the timed runs.
  for (const module of modules) {
    await prepare(module, count, expected, true)(frames)
  }
  const samples = [[], []]
  for (let iteration = 0; iteration < warmups + iterations; iteration++) {
    for (const arm of iteration % 2 === 0 ? [0, 1] : [1, 0]) {
      const elapsed = await prepare(modules[arm], count, expected, false)(frames)
      if (iteration >= warmups) {
        samples[arm].push(elapsed)
      }
    }
  }
  const beforeMs = median(samples[0])
  const afterMs = median(samples[1])
  results.push({
    backlog: count,
    beforeMs,
    afterMs,
    savedMs: beforeMs - afterMs,
    speedup: beforeMs / afterMs
  })
}
console.log(
  JSON.stringify(
    {
      runtime: process.version,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      iterations,
      warmups,
      framesPerTurn: modules[1].FRAME_DECODER_MAX_FRAMES_PER_TURN,
      sourceSha256: sources.map((source) => createHash('sha256').update(source).digest('hex')),
      scenario:
        'Production stream receive, JSON parse, cooperative decoder turns and ordered PTY delivery; production notify creates the ACK backlog before timing.',
      parity:
        'Full notifications, order, initial/final backlog and every intermediate ACK backlog match.',
      results
    },
    null,
    2
  )
)
