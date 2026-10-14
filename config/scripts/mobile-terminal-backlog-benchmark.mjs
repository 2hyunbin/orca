import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const baselinePath = process.argv[2]
if (!baselinePath) {
  throw new Error(
    'Usage: node config/scripts/mobile-terminal-backlog-benchmark.mjs <baseline-backlog.ts>'
  )
}
const target = fileURLToPath(
  new URL('../../mobile/src/mobile-web-shell/bridge-terminal-output-backlog.ts', import.meta.url)
)
async function load(source) {
  const result = await build({
    stdin: {
      contents:
        "export { BridgeTerminalOutputBacklog, TERMINAL_STREAM_ACK_SILENCE_MS, TERMINAL_STREAM_MAX_PENDING_BYTES } from 'benchmark-backlog'",
      resolveDir: dirname(target),
      loader: 'ts'
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'production-backlog',
        setup(builder) {
          builder.onResolve({ filter: /^benchmark-backlog$/ }, () => ({
            path: target,
            namespace: 'benchmark'
          }))
          builder.onLoad({ filter: /.*/, namespace: 'benchmark' }, () => ({
            contents: source,
            loader: 'ts',
            resolveDir: dirname(target)
          }))
          // The unused envelope sizing function is pure; omit its unused schema graph.
          builder.onResolve({ filter: /bridge-event-envelope-bytes$/ }, (args) => ({
            path: resolve(args.resolveDir, `${args.path}.ts`),
            sideEffects: false
          }))
        }
      }
    ]
  })
  return await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
}
const implementations = {
  before: await load(readFileSync(baselinePath, 'utf8')),
  after: await load(readFileSync(target, 'utf8'))
}
for (const field of ['TERMINAL_STREAM_ACK_SILENCE_MS', 'TERMINAL_STREAM_MAX_PENDING_BYTES']) {
  assert.equal(implementations.after[field], implementations.before[field])
}
const cap = 640 * 1024 - 128
const scenarios = [
  { name: 'idle echo', count: 1, units: 8, iterations: 1000 },
  { name: '5MiB cat, 48KiB host frames', count: 107, units: 49152, iterations: 3 },
  { name: '20s at 200fps, 1KiB frames', count: 4000, units: 1024, iterations: 3 },
  { name: '32MiB backlog, 1KiB frames', count: 31000, units: 1024, iterations: 1 },
  { name: 'fragmented redraw, 64-byte frames', count: 64000, units: 64, iterations: 1 }
]
function run(implementation, chunks, expected) {
  let armed = false
  let sets = 0
  let clears = 0
  const timers = {
    set: (_handler, ms) => {
      assert.equal(ms, implementation.TERMINAL_STREAM_ACK_SILENCE_MS)
      assert.equal(armed, false)
      armed = true
      sets += 1
      return sets
    },
    clear: (handle) => {
      assert.equal(handle, sets)
      assert.equal(armed, true)
      armed = false
      clears += 1
    }
  }
  const backlog = new implementation.BridgeTerminalOutputBacklog({
    onAckSilence: () => {
      throw new Error('Unexpected acknowledgement timeout')
    },
    timers
  })
  const started = performance.now()
  for (const chunk of chunks) {
    assert.equal(backlog.hold({ type: 'data', streamId: 7, chunk }), true)
  }
  const drainStarted = performance.now()
  const frames = []
  while (backlog.held) {
    const frame = backlog.next(cap, true)
    if (!frame || typeof frame !== 'object' || typeof frame.chunk !== 'string') {
      throw new Error('Invalid terminal frame')
    }
    frames.push(frame)
  }
  const ended = performance.now()
  assert.equal(frames.map((frame) => frame.chunk).join(''), expected)
  for (const frame of frames) {
    assert.equal(Buffer.byteLength(JSON.stringify(frame)) <= cap, true)
  }
  assert.equal(backlog.pendingBytes, 0)
  assert.equal(backlog.peakPendingBytes <= implementation.TERMINAL_STREAM_MAX_PENDING_BYTES, true)
  assert.equal(backlog.deliveredFrames, frames.length)
  assert.equal(backlog.coalescedFrames, chunks.length - frames.length)
  assert.deepEqual({ armed, sets, clears }, { armed: false, sets: 1, clears: 1 })
  const controls = {
    frames,
    peakPendingBytes: backlog.peakPendingBytes,
    deliveredFrames: backlog.deliveredFrames,
    coalescedFrames: backlog.coalescedFrames,
    pendingBytes: backlog.pendingBytes,
    timerSets: sets,
    timerClears: clears
  }
  backlog.dispose()
  assert.deepEqual({ armed, sets, clears }, { armed: false, sets: 1, clears: 1 })
  assert.equal(backlog.held, false)
  assert.equal(backlog.pendingBytes, 0)
  return { drainMs: ended - drainStarted, totalMs: ended - started, controls }
}
const median = (values) =>
  [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]
const results = []
for (const { name, count, units, iterations } of scenarios) {
  const chunks = Array.from({ length: count }, (_, index) =>
    `${index}\u001b[32m`.padEnd(units, 'x')
  )
  const expected = chunks.join('')
  const samples = { before: { drain: [], total: [] }, after: { drain: [], total: [] } }
  let expectedControls
  for (let sample = 0; sample < 9; sample += 1) {
    const order = sample % 2 === 0 ? ['before', 'after'] : ['after', 'before']
    for (const variant of order) {
      let drainMs = 0
      let totalMs = 0
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const actual = run(implementations[variant], chunks, expected)
        expectedControls ??= actual.controls
        assert.deepEqual(actual.controls, expectedControls)
        drainMs += actual.drainMs
        totalMs += actual.totalMs
      }
      if (sample >= 2) {
        samples[variant].drain.push(drainMs / iterations)
        samples[variant].total.push(totalMs / iterations)
      }
    }
  }
  const { frames: _frames, ...controls } = expectedControls
  results.push({
    name,
    count,
    units,
    iterations,
    deliveredUnits: expected.length,
    ...controls,
    beforeDrainMedianMs: median(samples.before.drain),
    afterDrainMedianMs: median(samples.after.drain),
    beforeTotalMedianMs: median(samples.before.total),
    afterTotalMedianMs: median(samples.after.total),
    samples
  })
}
console.log(
  JSON.stringify(
    {
      baselinePath,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      cap,
      pendingCap: implementations.after.TERMINAL_STREAM_MAX_PENDING_BYTES,
      acknowledgementSilenceMs: implementations.after.TERMINAL_STREAM_ACK_SILENCE_MS,
      schedule: '9 alternating paired runs, first 2 discarded',
      results
    },
    null,
    2
  )
)
