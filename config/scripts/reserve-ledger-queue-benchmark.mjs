import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { transform } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

// Save the pre-change reserve-ledger-writer.ts as UTF-8 and pass its path.
const [baselinePath, option] = process.argv.slice(2)
if (!baselinePath || process.argv.length > 4 || (option && option !== '--parity-only')) {
  throw new Error(
    'Usage: node config/scripts/reserve-ledger-queue-benchmark.mjs <baseline.ts> [--parity-only]'
  )
}
const currentSource = readFileSync(
  new URL('../../cloud/apps/relay/src/reserve-ledger-writer.ts', import.meta.url),
  'utf8'
)
const baselineSource = readFileSync(baselinePath, 'utf8')
assert.notEqual(baselineSource, currentSource, 'Do not compare the source to itself.')
async function load(source) {
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2024' })
  const production = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  )
  assert.equal(typeof production.ReserveLedgerWriter, 'function')
  return production
}
const implementations = { before: await load(baselineSource), after: await load(currentSource) }
const capacity = implementations.after.RESERVE_LEDGER_QUEUE_MAX
assert.equal(capacity, implementations.before.RESERVE_LEDGER_QUEUE_MAX)
assert.equal(capacity, 200_000)
const record = (epoch) => ({
  userId: 'benchmark-user',
  relayHostId: `host-${epoch}`,
  cellId: 'c1',
  epoch
})

async function parity(Writer, queueMax) {
  let now = 0
  let fail = true
  let deferred = false
  let finish
  const calls = []
  const summaries = []
  const pending = []
  const writer = new Writer(
    {
      query: async (sql, params) => {
        calls.push({ sql, params })
        if (fail) {
          fail = false
          throw new Error('database unavailable')
        }
        if (deferred) {
          deferred = false
          await new Promise((resolve) => {
            finish = resolve
          })
        }
        return []
      }
    },
    { queueMax, now: () => now, log: (line) => summaries.push(JSON.parse(line)) }
  )
  for (let epoch = 0; epoch < queueMax + 375; epoch++) {
    writer.enqueue({ ...record(epoch), relayHostId: `host-${epoch % 117}` })
  }
  assert.equal(writer.pending(), queueMax)
  await writer.flush()
  pending.push(writer.pending())
  await writer.flush()
  pending.push(writer.pending())
  now = 1_000
  deferred = true
  const flush = writer.flush()
  await writer.flush()
  for (let epoch = queueMax + 375; epoch < queueMax + 775; epoch++) {
    writer.enqueue(record(epoch))
  }
  pending.push(writer.pending())
  if (queueMax > 0) {
    assert.equal(typeof finish, 'function')
    finish()
  }
  await flush
  pending.push(writer.pending())
  while (writer.pending() > 0) {
    await writer.flush()
  }
  writer.enqueue(record(10_000))
  await writer.flush()
  now = 60_000
  await writer.flush()
  pending.push(writer.pending())
  return { calls, summaries, pending }
}
const parityCapacities = [0, 1, 500, 750, 1_000]
for (const queueMax of parityCapacities) {
  assert.deepEqual(
    await parity(implementations.after.ReserveLedgerWriter, queueMax),
    await parity(implementations.before.ReserveLedgerWriter, queueMax),
    `SQL payload, drop/summary and pending parity at capacity ${queueMax}`
  )
}

const entries =
  option === '--parity-only'
    ? []
    : Array.from({ length: capacity + 2_000 }, (_, epoch) => record(epoch))
const database = { query: async () => [] }
async function measure(Writer) {
  const writer = new Writer(database, { now: () => 1_000, log: () => {} })
  for (let index = 0; index < capacity; index++) {
    writer.enqueue(entries[index])
  }
  const burstStarted = performance.now()
  for (let index = capacity; index < entries.length; index++) {
    writer.enqueue(entries[index])
  }
  const burstMs = performance.now() - burstStarted
  assert.equal(writer.pending(), capacity)
  const backlogStarted = performance.now()
  for (let index = 0; index < 100; index++) {
    await writer.flush()
  }
  const backlogMs = performance.now() - backlogStarted
  assert.equal(writer.pending(), capacity - 50_000)
  const ordinary = new Writer(database, { now: () => 1_000, log: () => {} })
  const ordinaryStarted = performance.now()
  for (let index = 0; index < 1_000; index++) {
    ordinary.enqueue(entries[index])
    await ordinary.flush()
  }
  const ordinaryMs = performance.now() - ordinaryStarted
  assert.equal(ordinary.pending(), 0)
  return {
    cappedQueue2000EnqueuesMs: burstMs,
    backlog100FlushesMs: backlogMs,
    normal1000EnqueueFlushMs: ordinaryMs
  }
}
const samples = { before: [], after: [] }
const sampleOrder =
  option === '--parity-only' ? [] : buildCounterbalancedSchedule(8, 'before', 'after')
if (option !== '--parity-only') {
  for (const pair of buildCounterbalancedSchedule(2, 'before', 'after')) {
    for (const arm of pair) {
      await measure(implementations[arm].ReserveLedgerWriter)
    }
  }
  for (const pair of sampleOrder) {
    for (const arm of pair) {
      samples[arm].push(await measure(implementations[arm].ReserveLedgerWriter))
    }
  }
}
function summary(rows) {
  return Object.fromEntries(
    Object.keys(rows[0] ?? {}).map((key) => {
      const samplesMs = rows.map((row) => row[key])
      const values = [...samplesMs].sort((left, right) => left - right)
      const middle = values.length / 2
      return [key, { medianMs: (values[middle - 1] + values[middle]) / 2, samplesMs }]
    })
  )
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      capacity,
      parityCases: parityCapacities.length,
      parity: 'passed',
      warmupPairs: option === '--parity-only' ? 0 : 2,
      measuredPairs: samples.before.length,
      sampleOrder,
      before: summary(samples.before),
      after: summary(samples.after)
    },
    null,
    2
  )
)
