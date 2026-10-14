import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  evaluateWatchSample,
  initialWatchState,
  measuredBackground
} from './relay-reserve-watch-rules.mjs'
import { flipBack, parseWatchArguments, recordOutcome, watchSegment } from './watch-relay-reserve-cell.mjs'

const CELL = 'production-gce-c26'
const START = Date.parse('2026-10-14T12:00:00Z')
const MINUTE = 60_000
const LIMIT = { unverifiableLimit: 3 }

const healthyCell = (overrides = {}) => ({
  ok: true,
  admitModeConfigured: 'reserve',
  admitModeEffective: 'reserve',
  draining: false,
  controls: 1_000,
  enforcedUnits: 1_100,
  hardCap: 2_000,
  ...overrides
})
const minutesBefore = (at, count) =>
  Array.from({ length: count }, (_, index) =>
    new Date(Math.floor(at / MINUTE) * MINUTE - (count + 3 - index) * MINUTE).toISOString().slice(0, 16)
  )
const quiet503 = (at, perMinute = 10) => {
  const minutes = minutesBefore(at, 3)
  return { ok: true, minutes, perMinute: Object.fromEntries(minutes.map((minute) => [minute, perMinute])) }
}
const sampleAt = (at, overrides = {}) => ({
  at,
  cell: healthyCell(),
  director503: quiet503(at),
  ledger: { ok: true, unwrittenRows: 0, directors: 5 },
  seatBehindRow: { ok: true, reports: [] },
  ...overrides
})
const freshState = (overrides = {}) => ({
  ...initialWatchState({ cellId: CELL, startedAt: START, durationMinutes: 60, background503PerMinute: 10 }),
  ...overrides
})

// Runs samples one minute apart; returns every result.
function run(samples, state = freshState()) {
  const results = []
  for (const sample of samples) {
    const result = evaluateWatchSample(state, sample, LIMIT)
    results.push(result)
    state = result.state
    if (state.state !== 'watching') break
  }
  return results
}

test('a healthy cell keeps watching and completes at the deadline', () => {
  const results = run(Array.from({ length: 61 }, (_, minute) => sampleAt(START + minute * MINUTE)))
  assert.equal(results.length, 61)
  assert.ok(results.slice(0, 60).every((result) => result.state.state === 'watching'))
  assert.equal(results.at(-1).state.state, 'completed')
  const line = JSON.parse(results[0].line)
  assert.equal(line.event, 'orca_relay_reserve_watch_sample')
  assert.deepEqual(Object.keys(line.rules), ['deadMan', 'overrun', 'director503', 'duplicateSeat', 'hostDrop', 'ledgerDrift'])
})

test('503s trip only after three complete minutes over max(1.5x background, background + 20)', () => {
  // Background 100: the line is 150. Two minutes over and one under is not a trip.
  const state = freshState({ background: { medianPerMinute: 100, source: 'input' } })
  const series = (counts) => {
    const minutes = minutesBefore(START, 3)
    return { ok: true, minutes, perMinute: Object.fromEntries(minutes.map((minute, index) => [minute, counts[index]])) }
  }
  const twoOver = evaluateWatchSample(state, sampleAt(START, { director503: series([151, 140, 200]) }), LIMIT)
  assert.equal(twoOver.state.state, 'watching')
  const atLine = evaluateWatchSample(state, sampleAt(START, { director503: series([150, 150, 150]) }), LIMIT)
  assert.equal(atLine.state.state, 'watching')
  const threeOver = evaluateWatchSample(state, sampleAt(START, { director503: series([151, 160, 170]) }), LIMIT)
  assert.equal(threeOver.state.state, 'tripped')
  assert.match(threeOver.state.verdict, /^flip back production-gce-c26: director503: /)
  // A zero background still needs 20 a minute, not one 503.
  const zero = freshState({ background: { medianPerMinute: 0, source: 'input' } })
  assert.equal(evaluateWatchSample(zero, sampleAt(START, { director503: series([5, 5, 5]) }), LIMIT).state.state, 'watching')
  assert.equal(evaluateWatchSample(zero, sampleAt(START, { director503: series([21, 21, 21]) }), LIMIT).state.state, 'tripped')
  // A minute with no point had none.
  const gap = series([151, 160, 170])
  delete gap.perMinute[gap.minutes[1]]
  assert.equal(evaluateWatchSample(state, sampleAt(START, { director503: gap }), LIMIT).state.state, 'watching')
})

test('the measured background is the median of the minutes before the watch, zeros included', () => {
  const minutes = ['2026-10-14T11:47', '2026-10-14T11:48', '2026-10-14T11:49']
  assert.equal(measuredBackground({ '2026-10-14T11:48': 30 }, minutes).medianPerMinute, 0)
  assert.equal(measuredBackground({ [minutes[0]]: 10, [minutes[1]]: 30, [minutes[2]]: 20 }, minutes).medianPerMinute, 20)
  assert.equal(measuredBackground({}, []), null)
})

test('any overrun trips at once', () => {
  const [result] = run([sampleAt(START, { cell: healthyCell({ enforcedUnits: 2_001 }) })])
  assert.equal(result.state.state, 'tripped')
  assert.match(result.state.verdict, /overrun: ledger units 2001 over hard cap 2000/)
  const [atCap] = run([sampleAt(START, { cell: healthyCell({ enforcedUnits: 2_000 }) })])
  assert.equal(atCap.state.state, 'watching')
})

test('a seat reported behind its row again past the grace trips; inside the grace it does not', () => {
  const report = (at) => ({ at, key: '7:8' })
  const within = run([
    sampleAt(START, { seatBehindRow: { ok: true, reports: [report(START - 30_000)] } }),
    sampleAt(START + MINUTE, { seatBehindRow: { ok: true, reports: [report(START - 30_000), report(START + 50_000)] } })
  ])
  assert.equal(within.at(-1).state.state, 'watching')
  // Carried across samples: the second read no longer holds the first report.
  const past = run([
    sampleAt(START, { seatBehindRow: { ok: true, reports: [report(START - 30_000)] } }),
    sampleAt(START + 2 * MINUTE, { seatBehindRow: { ok: true, reports: [report(START + 70_000)] } })
  ])
  assert.equal(past.at(-1).state.state, 'tripped')
  assert.match(past.at(-1).state.verdict, /duplicateSeat: a seat behind its ledger row \(7:8\)/)
  // Another seat's report is not the same seat.
  const other = run([
    sampleAt(START, { seatBehindRow: { ok: true, reports: [report(START - 30_000)] } }),
    sampleAt(START + 2 * MINUTE, { seatBehindRow: { ok: true, reports: [{ at: START + 70_000, key: '3:4' }] } })
  ])
  assert.equal(other.at(-1).state.state, 'watching')
})

test('a host drop over 5% in 5 minutes trips outside a drain only', () => {
  const controls = [1_000, 990, 980, 960, 949]
  const samples = (draining) =>
    controls.map((count, minute) =>
      sampleAt(START + minute * MINUTE, { cell: healthyCell({ controls: count, draining: draining && minute === 2 }) })
    )
  assert.equal(run(samples(false)).at(-1).state.state, 'tripped')
  assert.match(run(samples(false)).at(-1).state.verdict, /hostDrop: connected hosts fell 1000 -> 949/)
  assert.equal(run(samples(true)).at(-1).state.state, 'watching')
  // A drop spread over more than 5 minutes is not one.
  const slow = [1_000, 990, 980, 970, 960, 955, 950].map((count, minute) =>
    sampleAt(START + minute * MINUTE, { cell: healthyCell({ controls: count }) })
  )
  assert.equal(run(slow).at(-1).state.state, 'watching')
  // Under the floor on a nearly empty cell: 100 -> 92 is 8%, but only 8 hosts.
  const small = [100, 92].map((count, minute) => sampleAt(START + minute * MINUTE, { cell: healthyCell({ controls: count }) }))
  assert.equal(run(small).at(-1).state.state, 'watching')
})

test('ledger drift over 0.5% trips once it has lasted 2 minutes', () => {
  const drift = (rows) => ({ ok: true, unwrittenRows: rows, directors: 5 })
  const brief = run([6, 6, 0, 6].map((rows, minute) => sampleAt(START + minute * MINUTE, { ledger: drift(rows) })))
  assert.equal(brief.at(-1).state.state, 'watching')
  const sustained = run([6, 6, 6].map((rows, minute) => sampleAt(START + minute * MINUTE, { ledger: drift(rows) })))
  assert.equal(sustained.length, 3)
  assert.equal(sustained.at(-1).state.state, 'tripped')
  assert.match(sustained.at(-1).state.verdict, /ledgerDrift: ledger drift 0\.60% for 120 s/)
  const atLine = run([5, 5, 5, 5].map((rows, minute) => sampleAt(START + minute * MINUTE, { ledger: drift(rows) })))
  assert.equal(atLine.at(-1).state.state, 'watching')
})

test('a tripped dead-man is a trip: Postgres still records reserve until a db write', () => {
  const [result] = run([sampleAt(START, { cell: healthyCell({ admitModeEffective: 'db' }) })])
  assert.equal(result.state.state, 'tripped')
  assert.match(result.state.verdict, /deadMan: the cell tripped its dead-man/)
})

test('unreadable data is never healthy: N samples in a row with any gap trip', () => {
  const unreadable = { ok: false, error: 'cell runtime status returned 502' }
  const gaps = [
    { cell: unreadable },
    { ledger: { ok: false, error: 'no placing director logged a ledger summary' } },
    { director503: { ok: false, error: 'director 503 metric read failed', perMinute: {}, minutes: [] } }
  ]
  const results = run(gaps.map((gap, minute) => sampleAt(START + minute * MINUTE, gap)))
  assert.deepEqual(results.map((result) => result.state.unverifiableStreak), [1, 2, 3])
  assert.equal(results.at(-1).state.state, 'tripped')
  assert.match(results.at(-1).state.verdict, /unverifiable: 3 samples in a row could not read director503/)
  // One whole sample resets the streak.
  const reset = run(
    [gaps[0], {}, gaps[0], gaps[0]].map((gap, minute) => sampleAt(START + minute * MINUTE, gap))
  )
  assert.deepEqual(reset.map((result) => result.state.unverifiableStreak), [1, 0, 1, 2])
  assert.equal(reset.at(-1).state.state, 'watching')
  // No background yet is a gap too.
  const noBackground = freshState({ background: null })
  assert.equal(evaluateWatchSample(noBackground, sampleAt(START), LIMIT).state.unverifiableStreak, 1)
  // A measured trip still wins over a gap elsewhere.
  const [both] = run([sampleAt(START, { cell: healthyCell({ enforcedUnits: 2_500 }), ledger: gaps[1].ledger })])
  assert.equal(both.state.state, 'tripped')
  assert.match(both.state.verdict, /overrun/)
})

test('a cell no longer in reserve stops the watch without a write; one never in reserve is refused', () => {
  const dbCell = healthyCell({ admitModeConfigured: 'db', admitModeEffective: 'reserve' })
  const [refused] = run([sampleAt(START, { cell: dbCell })])
  assert.equal(refused.state.state, 'refused')
  const later = run([sampleAt(START), sampleAt(START + MINUTE, { cell: dbCell })])
  assert.equal(later.at(-1).state.state, 'stopped')
  assert.match(later.at(-1).state.verdict, /is not in reserve mode \(switch file says db\)/)
})

const watchValues = (overrides = {}) => ({
  mode: 'dry-run',
  'cell-id': CELL,
  'cell-origin': 'https://c26.relay.onorca.dev',
  'project-id': 'onorca-cloud',
  'director-origin': 'https://relay.onorca.dev',
  'director-service': 'orca-cloud-relay',
  'duration-minutes': '120',
  'segment-minutes': '55',
  'unverifiable-limit': '3',
  'background-503-per-minute': '',
  'state-file': '/unused',
  ...overrides
})

test('watch arguments reuse the flag tool checks, so a write watch needs its confirmation up front', () => {
  assert.equal(parseWatchArguments(watchValues()).background503PerMinute, null)
  assert.equal(parseWatchArguments(watchValues({ 'background-503-per-minute': '12.5' })).background503PerMinute, 12.5)
  assert.throws(() => parseWatchArguments(watchValues({ mode: 'write' })), /WRITE_RELAY_CELL_FLAGS production-gce-c26/)
  assert.doesNotThrow(() =>
    parseWatchArguments(watchValues({ mode: 'write', confirmation: `WRITE_RELAY_CELL_FLAGS ${CELL}` }))
  )
  assert.throws(() => parseWatchArguments(watchValues({ 'cell-origin': 'https://c27.relay.onorca.dev' })), /names another cell/)
  assert.throws(() => parseWatchArguments(watchValues({ 'duration-minutes': '301' })), /duration-minutes/)
  assert.throws(() => parseWatchArguments(watchValues({ 'segment-minutes': '56' })), /segment-minutes/)
  assert.throws(() => parseWatchArguments(watchValues({ 'background-503-per-minute': '-1' })), /background/)
})

// A cell, Cloud Monitoring and Cloud Logging, answering from `script` per sample.
function fakeSources({ cell = () => ({}), ledger = () => [{ timestamp: new Date(START).toISOString(), labels: { instanceId: 'a' }, jsonPayload: { pending: 0, dropped: 0 } }] } = {}) {
  let samples = 0
  const fetchImpl = async (url) => {
    const text = String(url)
    if (text.endsWith('/v1/admin/runtime-status')) {
      samples += 1
      const overrides = cell(samples)
      return new Response(
        JSON.stringify({
          role: 'cell',
          cellId: CELL,
          draining: false,
          flagsApplied: { generation: 4, flags: { admitMode: 'reserve', readinessLocal: true } },
          admitModeEffective: 'reserve',
          connectionCapacity: { hardCap: 2_000 },
          runtime: { controls: 1_000, enforcedConnectionUnits: 1_100 },
          ...overrides
        })
      )
    }
    if (text.startsWith('https://monitoring.googleapis.com/')) return new Response(JSON.stringify({ timeSeries: [] }))
    throw new Error(`unexpected fetch ${text}`)
  }
  const runGcloud = async (args) => {
    if (args[0] === 'auth') return { stdout: 'token' }
    const filter = args[2]
    if (filter.includes('orca_relay_reserve_ledger_summary')) return { stdout: JSON.stringify(ledger(samples)) }
    return { stdout: '[]' }
  }
  return { fetchImpl, runGcloud }
}

test('a segment samples once a minute, carries state to the next segment, and stops on a trip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reserve-watch-'))
  try {
    let clock = START
    const lines = []
    const config = parseWatchArguments(
      watchValues({ 'state-file': join(directory, 'state.json'), 'github-output': join(directory, 'out'), 'segment-minutes': '3' })
    )
    const sources = fakeSources({ cell: (sample) => (sample === 5 ? { runtime: { controls: 1_000, enforcedConnectionUnits: 2_001 } } : {}) })
    const dependencies = {
      ...sources,
      idToken: 'id',
      retryDelayMs: 0,
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      log: (line) => lines.push(JSON.parse(line))
    }
    const first = await watchSegment(config, dependencies)
    assert.equal(first.state, 'watching')
    assert.equal(lines.length, 3)
    assert.equal(first.background.source, 'measured')
    assert.equal(await readFile(join(directory, 'out'), 'utf8'), 'state=watching\nverdict=\n')
    const second = await watchSegment(config, dependencies)
    assert.equal(second.state, 'tripped')
    assert.equal(second.samples, 5)
    assert.deepEqual(lines.map((line) => line.sample), [1, 2, 3, 4, 5])
    assert.equal(lines.at(-1).rules.overrun.status, 'trip')
    assert.match(await readFile(join(directory, 'out'), 'utf8'), /state=tripped\nverdict=flip back production-gce-c26: overrun: /)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a sample that cannot read its sources counts as unverifiable rather than crashing the watch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reserve-watch-'))
  try {
    let clock = START
    const config = parseWatchArguments(watchValues({ 'state-file': join(directory, 'state.json'), 'segment-minutes': '10' }))
    const sources = fakeSources({ ledger: () => [] })
    const state = await watchSegment(config, {
      ...sources,
      idToken: 'id',
      retryDelayMs: 0,
      now: () => clock,
      sleep: async (ms) => { clock += ms },
      log: () => {}
    })
    assert.equal(state.state, 'tripped')
    assert.equal(state.samples, 3)
    assert.match(state.verdict, /unverifiable: 3 samples in a row could not read ledgerDrift/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a watch that ended without a verdict records failed, which starts no flip back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-reserve-watch-'))
  try {
    const output = join(directory, 'out')
    assert.equal((await recordOutcome(join(directory, 'missing.json'), output)).state, 'failed')
    await writeFile(join(directory, 'watching.json'), JSON.stringify(freshState()))
    assert.equal((await recordOutcome(join(directory, 'watching.json'), output)).state, 'failed')
    await writeFile(join(directory, 'tripped.json'), JSON.stringify(freshState({ state: 'tripped', verdict: 'flip back x:\ny' })))
    assert.equal((await recordOutcome(join(directory, 'tripped.json'), output)).state, 'tripped')
    assert.match(await readFile(output, 'utf8'), /state=tripped\nverdict=flip back x: y\n$/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// Google Storage and the director, as far as the flag tool's flip back reaches them.
function fakeFlipBack({ generation = '7', admitModeAfterWrite = 'db' } = {}) {
  const calls = []
  let applied = { generation: Number(generation), flags: { admitMode: 'reserve', readinessLocal: true } }
  const fetchImpl = async (url, init = {}) => {
    const text = String(url)
    calls.push({ url: text, method: init.method ?? 'GET', body: init.body })
    if (text.includes('/upload/storage/v1/')) {
      assert.match(text, new RegExp(`ifGenerationMatch=${generation}$`))
      applied = { generation: Number(generation) + 1, flags: { admitMode: admitModeAfterWrite, readinessLocal: true } }
      return new Response(JSON.stringify({ generation: String(Number(generation) + 1) }))
    }
    if (text.includes('?alt=media')) {
      return new Response(JSON.stringify({ v: 1, cellId: CELL, flags: { admitMode: 'reserve', readinessLocal: true } }))
    }
    if (text.includes('/storage/v1/b/')) return new Response(JSON.stringify({ generation }))
    if (text.endsWith('/v1/admin/runtime-status')) {
      return new Response(
        JSON.stringify({
          role: 'cell',
          cellId: CELL,
          flagsApplied: applied,
          supportedFlags: {
            admitMode: { type: 'enum', values: ['db', 'reserve'] },
            readinessLocal: { type: 'boolean' }
          },
          admitModeEffective: applied.flags.admitMode,
          runtime: { controls: 10 }
        })
      )
    }
    if (text.endsWith('/v1/admin/cell-admit-mode')) {
      const admitMode = JSON.parse(init.body).admitMode
      return new Response(JSON.stringify({ v: 1, cellId: CELL, admitMode: admitMode ?? 'reserve', heartbeatFresh: true }))
    }
    throw new Error(`unexpected fetch ${text}`)
  }
  return { fetchImpl, calls }
}

const flipValues = (overrides = {}) => ({
  mode: 'write',
  'cell-id': CELL,
  'cell-origin': 'https://c26.relay.onorca.dev',
  'project-id': 'onorca-cloud',
  'director-origin': 'https://relay.onorca.dev',
  confirmation: `WRITE_RELAY_CELL_FLAGS ${CELL}`,
  ...overrides
})

test('the flip back is the flag tool write: admitMode=db at the generation just read, then Postgres db', async () => {
  const { fetchImpl, calls } = fakeFlipBack()
  let clock = START
  const lines = []
  const result = await flipBack(flipValues(), {
    fetchImpl,
    accessToken: 'access',
    idToken: 'id',
    audit: { writtenBy: 'reserve-watch/test', runId: '1', runAttempt: '1' },
    now: () => clock,
    sleep: async (ms) => { clock += ms },
    log: (line) => lines.push(JSON.parse(line))
  })
  assert.equal(result.written, true)
  const upload = calls.find((call) => call.url.includes('/upload/storage/v1/'))
  assert.match(upload.body, /"flags":\{"admitMode":"db","readinessLocal":true\}/)
  assert.ok(calls.some((call) => call.url.endsWith('/v1/admin/cell-admit-mode') && JSON.parse(call.body).admitMode === 'db'))
  assert.deepEqual(lines.at(-1), {
    event: 'orca_relay_reserve_watch_flip_back',
    mode: 'write',
    cellId: CELL,
    written: true,
    generation: '8'
  })
})

test('a dry-run flip back plans the write and writes nothing', async () => {
  const { fetchImpl, calls } = fakeFlipBack()
  const lines = []
  const result = await flipBack(flipValues({ mode: 'dry-run', confirmation: '' }), {
    fetchImpl,
    accessToken: 'access',
    idToken: 'id',
    audit: {},
    sleep: async () => {},
    log: (line) => lines.push(JSON.parse(line))
  })
  assert.equal(result.written, false)
  assert.ok(!calls.some((call) => call.url.includes('/upload/')))
  assert.ok(!calls.some((call) => call.url.endsWith('/v1/admin/cell-admit-mode') && JSON.parse(call.body).admitMode))
  assert.equal(lines.find((line) => line.event === 'orca_relay_cell_flags_plan').desired.flags.admitMode, 'db')
})

test('a write flip back without the typed confirmation is refused before any read', async () => {
  const { fetchImpl, calls } = fakeFlipBack()
  await assert.rejects(
    flipBack(flipValues({ confirmation: '' }), { fetchImpl, accessToken: 'a', idToken: 'i', audit: {}, log: () => {} }),
    /WRITE_RELAY_CELL_FLAGS production-gce-c26/
  )
  assert.equal(calls.length, 0)
})
