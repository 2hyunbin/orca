import assert from 'node:assert/strict'
import { BASELINE_REF } from './check-job-log-performance-cases.mjs'

export function assertWatchdogExit(result) {
  const signalExit = result.code === null && ['SIGTERM', 'SIGKILL'].includes(result.signal)
  assert(result.timedOut === true && signalExit, 'Unverified watchdog termination')
}

export const adverseCaseKey = (descriptor) =>
  JSON.stringify([
    descriptor.family,
    descriptor.width,
    descriptor.bytes,
    descriptor.variant,
    descriptor.terminator,
    descriptor.seed,
    descriptor.generator
  ])

export function auditBaselineCensoring(manifest, byId) {
  for (const descriptor of manifest) {
    const record = byId.get(descriptor.id)
    if (descriptor.mode === 'watchdog' || record.status === 'watchdog_passed') {
      assert(
        descriptor.mode === 'watchdog' &&
          record.status === 'watchdog_passed' &&
          record.attempted === true
      )
      assert(record.settlementMs < 15000)
      assert.equal(record.identity.baselineRef, BASELINE_REF)
      assertWatchdogExit(record.watchdogTermination)
      assert.equal(record.code, record.watchdogTermination.code)
      assert.equal(record.signal, record.watchdogTermination.signal)
    }
    if (record.status === 'baseline_timeout') {
      assert(
        descriptor.baselineTimeoutAllowed &&
          descriptor.arm === 'baseline' &&
          descriptor.mode === 'direct'
      )
      assert(record.attempted === true && ['warmup', 'sample'].includes(record.phase))
      assert.equal(record.deadlineMs, 10000)
      assert(record.settlementMs < 15000)
      assert.equal(record.identity.baselineRef, BASELINE_REF)
      assertWatchdogExit(record.watchdogTermination)
    }
    if (record.status === 'baseline_censored') {
      const initial = byId.get(record.initialTimeoutId)
      assert(
        descriptor.baselineTimeoutAllowed && descriptor.sample > 0 && record.attempted === false
      )
      assert(
        initial?.status === 'baseline_timeout' &&
          initial.sample === 0 &&
          initial.attempted === true,
        'Missing verified initial adverse attempt'
      )
      assert.equal(
        adverseCaseKey(record),
        adverseCaseKey(initial),
        'Censoring crossed adverse cases'
      )
      assertWatchdogExit(initial.watchdogTermination)
      assert.deepEqual(record.identity, { ...initial.identity, id: descriptor.id })
      for (const field of ['inputBytes', 'codeUnits', 'inputHash']) {
        assert.equal(record[field], initial[field])
      }
    }
  }
  for (const descriptor of manifest.filter(
    (item) => item.mode === 'direct' && item.baselineTimeoutAllowed && item.sample === 0
  )) {
    const slots = manifest.filter(
      (item) =>
        item.mode === 'direct' &&
        item.baselineTimeoutAllowed &&
        adverseCaseKey(item) === adverseCaseKey(descriptor)
    )
    assert.equal(slots.length, 7, 'Incomplete adverse baseline logical slots')
    assert.deepEqual(
      slots.map((item) => item.sample).toSorted((a, b) => a - b),
      [0, 1, 2, 3, 4, 5, 6]
    )
    for (const slot of slots) {
      const record = byId.get(slot.id)
      assert(
        record.attempted === true || record.status === 'baseline_censored',
        'Unattempted baseline sample'
      )
      assert.equal(
        record.status === 'completed' ? record.samples.length : record.unavailableSamples,
        1
      )
    }
  }
}
