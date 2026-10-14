import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  auditResults,
  runDescriptor
} from '../../config/scripts/check-job-log-byte-cap-benchmark.mjs'
import {
  BASELINE_REF,
  createManifest
} from '../../config/scripts/check-job-log-performance-cases.mjs'

const launcher = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess: launcher }))
afterEach(() => launcher.mockReset())

const context = {
  root: process.cwd(),
  identity: {
    baselineRef: BASELINE_REF,
    baselineSourceHashes: { ansi: 'frozen' },
    proposedSourceHashes: { ansi: 'current' }
  },
  bundles: {
    'baseline-negative': { filename: 'baseline.mjs', hash: 'negative-bundle' },
    baseline: { filename: 'baseline.mjs', hash: 'baseline-bundle' },
    proposed: { filename: 'proposed.mjs', hash: 'proposed-bundle' }
  }
}
const adverse = {
  id: 'negative-case',
  mode: 'direct',
  arm: 'baseline',
  family: 'osc',
  width: 7,
  bytes: 16384,
  samples: 7,
  baselineTimeoutAllowed: true
}
const ready = (id = adverse.id, bundleHash = context.bundles['baseline-negative'].hash) => ({
  type: 'ready',
  identity: { ...context.identity, id, bundleHash },
  runtime: { node: process.version, platform: process.platform, arch: process.arch, bun: false },
  inputBytes: 16384,
  codeUnits: 16384
})
const protocol = (records: object[]): string =>
  `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
const timeoutResult = () => ({
  code: null,
  signal: 'SIGTERM',
  timedOut: true,
  outputTruncated: false,
  stderr: '',
  stdout: protocol([ready(), { type: 'entered-strip', phase: 'warmup' }])
})

describe('performance watchdog failure precedence and completeness', () => {
  it('censors only a verified frozen adverse stripper entered under the watchdog', async () => {
    launcher.mockResolvedValue(timeoutResult())
    const record = await runDescriptor(context, adverse)
    expect(record.status).toBe('baseline_timeout')
    expect(record.samples).toEqual([])
    expect(record.unavailableSamples).toBe(7)
    expect(record.deadlineMs).toBe(10000)
    expect(launcher).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 10000,
        maxOutputBytes: 65536,
        env: expect.objectContaining({ ORCA_BACKGROUND_LAUNCH: '1' })
      })
    )
  })
  it.each([
    'startup',
    'identity',
    'truncated',
    'stderr',
    'crash',
    'unexpected-signal',
    'pre-call-only'
  ])('rejects %s failures rather than labeling them baseline timeouts', async (failure) => {
    const result = timeoutResult()
    if (failure === 'startup') {
      result.stdout = ''
    }
    if (failure === 'identity') {
      result.stdout = protocol([ready('wrong-case'), { type: 'entered-strip', phase: 'warmup' }])
    }
    if (failure === 'truncated') {
      result.outputTruncated = true
    }
    if (failure === 'stderr') {
      result.stderr = 'sentinel fixture construction failure'
    }
    if (failure === 'crash') {
      result.timedOut = false
      result.signal = 'SIGSEGV'
    }
    if (failure === 'unexpected-signal') {
      result.signal = 'SIGSEGV'
    }
    if (failure === 'pre-call-only') {
      result.stdout = protocol([ready(), { type: 'entered', phase: 'warmup' }])
    }
    launcher.mockResolvedValue(result)
    await expect(runDescriptor(context, adverse)).rejects.toThrow()
  })
  it.each(['proposed', 'ordinary-baseline'])('rejects %s workload timeouts', async (arm) => {
    const baseline = arm === 'ordinary-baseline'
    const descriptor = {
      ...adverse,
      arm: baseline ? 'baseline' : 'proposed',
      baselineTimeoutAllowed: false
    }
    launcher.mockResolvedValue({
      ...timeoutResult(),
      stdout: protocol([
        ready(descriptor.id, context.bundles[baseline ? 'baseline' : 'proposed'].hash),
        { type: 'entered', phase: 'warmup' }
      ])
    })
    await expect(runDescriptor(context, descriptor)).rejects.toThrow(
      'Workload child failed or timed out'
    )
  })
  it('predeclares full proposed coverage before adverse baseline descriptors', () => {
    const manifest = createManifest({ fixturePath: 'fixture.json' })
    const firstBaseline = manifest.findIndex((item) => item.arm === 'baseline')
    const lastCoverage = manifest.findLastIndex((item) => item.mode === 'coverage')
    expect(lastCoverage).toBeLessThan(firstBaseline)
    expect(new Set(manifest.map((item) => item.id)).size).toBe(manifest.length)
    expect(
      manifest
        .filter((item) => item.baselineTimeoutAllowed)
        .every(
          (item) =>
            item.arm === 'baseline' &&
            item.mode === 'direct' &&
            ['osc', 'dcs', 'apc', 'pm', 'sos'].includes(item.family)
        )
    ).toBe(true)
    expect(
      manifest.some(
        (item) =>
          item.mode === 'coverage' &&
          item.bytes === 63 * 1024 * 1024 &&
          item.width === 8 &&
          item.position === 'earlier'
      )
    ).toBe(true)
  })
  it('fails missing records and never turns an ordinary failure into completed coverage', () => {
    expect(() => auditResults([adverse], [])).toThrow('Incomplete')
    expect(() => auditResults([adverse], [{ id: adverse.id, status: 'failed' }])).toThrow(
      'Failed descriptor'
    )
  })
})
