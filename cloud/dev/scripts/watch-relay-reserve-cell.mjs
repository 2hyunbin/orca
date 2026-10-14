#!/usr/bin/env node
// Watches one cell already in reserve mode and, on the first stop rule it trips, flips it back to
// db through the flag tool's own write (CAS, read-back, re-registration wait). Step 5 design §9.
//
// watch:     one segment of the watch (the workflow re-authenticates between segments, since an
//            ID token lasts an hour). State carries over in --state-file. Writes nothing.
// outcome:   the job's state and verdict, from the state file.
// flip-back: the flag tool's admitMode=db write (or its dry run), then exits non-zero with the
//            watch's verdict.
import { execFile } from 'node:child_process'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { parseArgs, promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import {
  operateCellFlags,
  parseCellFlagsRequest,
  readCurrentObject,
  readRuntime
} from './operate-relay-cell-flags.mjs'
import { readDirector503PerMinute, readLogEntries } from './relay-same-cap-shadow-gate.mjs'
import { minutesOf } from './relay-same-cap-shadow-gate-verdict.mjs'
import {
  evaluateWatchSample,
  initialWatchState,
  measuredBackground,
  RESERVE_WATCH_RULES
} from './relay-reserve-watch-rules.mjs'

const execFileAsync = promisify(execFile)
const MINUTE_MS = 60_000
export const SAMPLE_INTERVAL_MS = MINUTE_MS
export const MAX_WATCH_MINUTES = 300
// Below the hour an ID token lasts, with room for the segment's last sample.
export const MAX_SEGMENT_MINUTES = 55
// Cloud Run publishes a minute's request count up to 3 minutes late.
const METRIC_DELAY_MS = 3 * MINUTE_MS
const BACKGROUND_MINUTES = 10
const SAMPLE_READ_BUDGET_MS = 40_000
const LOG_ENTRY_LIMIT = 1_000

function integerIn(name, raw, min, max) {
  const value = Number(raw)
  if (!/^[0-9]+$/.test(raw ?? '') || value < min || value > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

export function parseWatchArguments(values) {
  // The flag tool's own checks, so the watch is of exactly the cell the flip back would write;
  // a write-mode watch refuses a missing confirmation now, not hours later.
  const request = parseCellFlagsRequest({
    ...values,
    set: 'admitMode=db',
    'expected-generation': '0'
  })
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(values['director-service'] ?? '')) {
    throw new Error('--director-service is not a Cloud Run service name')
  }
  const background = values['background-503-per-minute'] ?? ''
  if (background !== '' && !/^(0|[1-9][0-9]{0,6})(\.[0-9]+)?$/.test(background)) {
    throw new Error('--background-503-per-minute must be empty (measure it) or a non-negative number')
  }
  if (!values['state-file']) throw new Error('--state-file is required')
  return {
    request,
    directorService: values['director-service'],
    durationMinutes: integerIn('duration-minutes', values['duration-minutes'], 5, MAX_WATCH_MINUTES),
    segmentMinutes: integerIn('segment-minutes', values['segment-minutes'], 1, MAX_SEGMENT_MINUTES),
    unverifiableLimit: integerIn('unverifiable-limit', values['unverifiable-limit'], 1, 30),
    background503PerMinute: background === '' ? null : Number(background),
    stateFile: values['state-file'],
    githubOutput: values['github-output'] || null
  }
}

const failedRead = (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })

export async function readCellSample(fetchImpl, request, idToken, wait) {
  try {
    const runtime = await readRuntime(fetchImpl, request, idToken, wait)
    if (runtime.role !== 'cell' || runtime.cellId !== request.cellId) {
      return failedRead(`origin answers as ${runtime.role}/${runtime.cellId}`)
    }
    if (!runtime.flagsApplied) return failedRead('runtime-status reports no flagsApplied')
    const controls = runtime.runtime?.controls
    if (!Number.isInteger(controls)) return failedRead('runtime-status reports no control count')
    return {
      ok: true,
      admitModeConfigured: runtime.flagsApplied.flags?.admitMode ?? 'db',
      admitModeEffective: runtime.admitModeEffective,
      draining: runtime.draining === true,
      controls,
      enforcedUnits: runtime.runtime?.enforcedConnectionUnits,
      hardCap: runtime.connectionCapacity?.hardCap
    }
  } catch (error) {
    return failedRead(error)
  }
}

// Complete minutes only: `endAt` is held back past the metric's publishing delay.
export async function readDirector503Minutes(reader, { projectId, directorService, endAt, minutes }) {
  const endedAt = new Date(Math.floor((endAt - METRIC_DELAY_MS) / MINUTE_MS) * MINUTE_MS)
  const span = { startedAt: new Date(endedAt.getTime() - minutes * MINUTE_MS), endedAt }
  const read = await readDirector503PerMinute(reader, { config: { projectId, directorService }, span })
  if (read.failed) return { ok: false, error: 'director 503 metric read failed', perMinute: {}, minutes: [] }
  return { ok: true, perMinute: read.perMinute, minutes: minutesOf(span) }
}

function directorLogFilter(directorService, event, sinceAt) {
  return [
    'resource.type="cloud_run_revision"',
    `resource.labels.service_name="${directorService}"`,
    `jsonPayload.event="${event}"`,
    `timestamp>="${new Date(sinceAt).toISOString()}"`
  ].join(' AND ')
}

// Newest summary per director instance; queued plus dropped rows are the ones not in Postgres.
export async function readLedgerSample(reader, { directorService, at }) {
  const read = await readLogEntries(reader, {
    filter: directorLogFilter(directorService, 'orca_relay_reserve_ledger_summary', at - RESERVE_WATCH_RULES.ledgerSummaryMaxAgeMs),
    projection: 'json(timestamp,labels.instanceId,jsonPayload.pending,jsonPayload.dropped)',
    limit: LOG_ENTRY_LIMIT
  })
  if (read.failed) return failedRead(read.error)
  if (read.entries.length >= LOG_ENTRY_LIMIT) return failedRead('ledger summary read truncated')
  if (read.entries.length === 0) return failedRead('no placing director logged a ledger summary')
  const newest = new Map()
  for (const entry of read.entries) {
    const instance = entry.labels?.instanceId ?? 'unknown'
    const previous = newest.get(instance)
    if (!previous || Date.parse(entry.timestamp) > Date.parse(previous.timestamp)) newest.set(instance, entry)
  }
  let unwrittenRows = 0
  for (const entry of newest.values()) {
    const pending = Number(entry.jsonPayload?.pending)
    const dropped = Number(entry.jsonPayload?.dropped)
    if (!Number.isFinite(pending) || !Number.isFinite(dropped)) return failedRead('ledger summary without counts')
    unwrittenRows += pending + dropped
  }
  return { ok: true, unwrittenRows, directors: newest.size }
}

export async function readSeatBehindRowSample(reader, { directorService, cellId, at }) {
  const read = await readLogEntries(reader, {
    filter: `${directorLogFilter(
      directorService,
      'orca_relay_reserve_ledger_seat_behind_row',
      at - RESERVE_WATCH_RULES.duplicateSeat.lookbackMs
    )} AND jsonPayload.cellId="${cellId}"`,
    projection: 'json(timestamp,jsonPayload.epoch,jsonPayload.rowEpoch)',
    limit: LOG_ENTRY_LIMIT
  })
  if (read.failed) return failedRead(read.error)
  if (read.entries.length >= LOG_ENTRY_LIMIT) return failedRead('seat-behind-row read truncated')
  return {
    ok: true,
    reports: read.entries.map((entry) => ({
      at: Date.parse(entry.timestamp),
      key: `${entry.jsonPayload?.epoch}:${entry.jsonPayload?.rowEpoch}`
    }))
  }
}

function createReader(dependencies, projectId) {
  const now = dependencies.now
  return {
    runGcloud: dependencies.runGcloud,
    fetch: dependencies.fetchImpl,
    retryDelayMs: dependencies.retryDelayMs ?? 5_000,
    readTimeoutMs: 20_000,
    now,
    // Every sample gets its own budget, so a slow read costs one sample, not the watch.
    deadlineAt: now() + SAMPLE_READ_BUDGET_MS,
    projectId
  }
}

async function loadState(path) {
  const text = await readFile(path, 'utf8').catch((error) => (error?.code === 'ENOENT' ? null : Promise.reject(error)))
  return text === null ? null : JSON.parse(text)
}

export async function watchSegment(config, dependencies) {
  const now = dependencies.now ?? Date.now
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const log = dependencies.log ?? console.log
  const deps = { ...dependencies, now, sleep, fetchImpl: dependencies.fetchImpl ?? fetch }
  const { request, directorService } = config
  let state =
    (await loadState(config.stateFile)) ??
    initialWatchState({
      cellId: request.cellId,
      startedAt: now(),
      durationMinutes: config.durationMinutes,
      background503PerMinute: config.background503PerMinute
    })
  if (state.cellId !== request.cellId) throw new Error(`state file is for ${state.cellId}, not ${request.cellId}`)
  const segmentEndsAt = now() + config.segmentMinutes * MINUTE_MS
  while (state.state === 'watching' && now() < segmentEndsAt) {
    const at = now()
    if (!state.background) {
      // The minutes just before the watch began; retried every sample until one read completes.
      const read = await readDirector503Minutes(createReader(deps, request.projectId), {
        projectId: request.projectId,
        directorService,
        endAt: state.startedAt,
        minutes: BACKGROUND_MINUTES
      })
      state = { ...state, background: read.ok ? measuredBackground(read.perMinute, read.minutes) : null }
    }
    const reader = createReader(deps, request.projectId)
    // Serialised: concurrent Logging reads are what earn a 429.
    const sample = {
      at,
      cell: await readCellSample(deps.fetchImpl, request, dependencies.idToken, sleep),
      director503: await readDirector503Minutes(reader, {
        projectId: request.projectId,
        directorService,
        endAt: at,
        minutes: RESERVE_WATCH_RULES.director503.consecutiveMinutes
      }),
      ledger: await readLedgerSample(reader, { directorService, at }),
      seatBehindRow: await readSeatBehindRowSample(reader, { directorService, cellId: request.cellId, at })
    }
    const result = evaluateWatchSample(state, sample, { unverifiableLimit: config.unverifiableLimit })
    state = result.state
    log(result.line)
    await writeFile(config.stateFile, JSON.stringify(state))
    if (state.state !== 'watching') break
    await sleep(Math.max(0, at + SAMPLE_INTERVAL_MS - now()))
  }
  if (config.githubOutput) await writeOutcome(config.githubOutput, state)
  return state
}

function writeOutcome(githubOutput, { state, verdict }) {
  return appendFile(githubOutput, `state=${state}\nverdict=${(verdict ?? '').replace(/[\r\n]+/g, ' ')}\n`)
}

// The job's outcome: a watch that ended mid-segment (a crash, a timeout) has no verdict and
// starts no flip back.
export async function recordOutcome(stateFile, githubOutput) {
  const state = await loadState(stateFile).catch(() => null)
  const outcome =
    state && state.state !== 'watching' ? state : { state: 'failed', verdict: 'the watch stopped before a verdict' }
  await writeOutcome(githubOutput, outcome)
  return outcome
}

// The flag tool's admitMode=db write, at the generation read just now: its CAS still refuses a
// write that lands after anyone else's.
export async function flipBack(values, dependencies) {
  const log = dependencies.log ?? console.log
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const base = parseCellFlagsRequest({ ...values, set: 'admitMode=db', 'expected-generation': '0' })
  const current = await readCurrentObject(fetchImpl, base, dependencies.accessToken)
  const result = await operateCellFlags(
    { ...base, expectedGeneration: current.generation },
    { ...dependencies, fetchImpl, log }
  )
  log(
    JSON.stringify({
      event: 'orca_relay_reserve_watch_flip_back',
      mode: base.mode,
      cellId: base.cellId,
      written: result.written,
      generation: result.generation ?? null
    })
  )
  return result
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...rest] = process.argv.slice(2)
  const { values } = parseArgs({
    args: rest,
    options: Object.fromEntries(
      [
        'mode',
        'cell-id',
        'cell-origin',
        'project-id',
        'director-origin',
        'director-service',
        'confirmation',
        'duration-minutes',
        'segment-minutes',
        'unverifiable-limit',
        'background-503-per-minute',
        'state-file',
        'github-output',
        'verdict'
      ].map((name) => [name, { type: 'string' }])
    )
  })
  const idToken = process.env.ORCA_RELAY_ADMIN_ID_TOKEN
  try {
    if (command === 'outcome') {
      if (!values['state-file'] || !values['github-output']) throw new Error('--state-file and --github-output are required')
      console.log(JSON.stringify({ event: 'orca_relay_reserve_watch_outcome', ...(await recordOutcome(values['state-file'], values['github-output'])) }))
    } else if (!idToken) {
      throw new Error('ORCA_RELAY_ADMIN_ID_TOKEN is required')
    } else if (command === 'watch') {
      const state = await watchSegment(parseWatchArguments(values), {
        idToken,
        runGcloud: (args, { timeoutMs }) =>
          execFileAsync('gcloud', args, { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' })
      })
      // A cell that was never reserve is the operator's mistake; one flipped back by hand is not.
      if (state.state === 'refused') {
        console.log(JSON.stringify({ event: 'orca_relay_reserve_watch_refused', verdict: state.verdict }))
        process.exitCode = 1
      }
    } else if (command === 'flip-back') {
      const accessToken = process.env.ORCA_RELAY_CONTROL_ACCESS_TOKEN
      if (!accessToken) throw new Error('ORCA_RELAY_CONTROL_ACCESS_TOKEN is required')
      if (!values.verdict) throw new Error('--verdict is required')
      await flipBack(values, {
        accessToken,
        idToken,
        audit: {
          writtenBy: `reserve-watch/${process.env.GITHUB_TRIGGERING_ACTOR ?? process.env.GITHUB_ACTOR ?? 'unknown'}`,
          runId: process.env.GITHUB_RUN_ID ?? 'local',
          runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '0'
        }
      })
      // A trip is a failed watch even once the cell is safely back on db.
      console.log(JSON.stringify({ event: 'orca_relay_reserve_watch_verdict', mode: values.mode, verdict: values.verdict }))
      process.exitCode = 1
    } else {
      throw new Error('command must be watch, outcome or flip-back')
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        event: 'orca_relay_reserve_watch_failed',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    process.exitCode = 1
  }
}
