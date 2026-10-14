import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  auditResults,
  prepareBenchmark,
  runDescriptor
} from '../../config/scripts/check-job-log-byte-cap-benchmark.mjs'
import { createManifest } from '../../config/scripts/check-job-log-performance-cases.mjs'

const root = process.cwd()
const manifest = createManifest({
  fixturePath: path.join(
    root,
    'src',
    'shared',
    '__fixtures__',
    'check-job-log-failure-output.json'
  ),
  capturePath: process.env.ORCA_CHECK_LOG_CAPTURE
})
let context: Awaited<ReturnType<typeof prepareBenchmark>>
const records: Awaited<ReturnType<typeof runDescriptor>>[] = []

describe('isolated source-pinned CI log performance matrix', { concurrent: false }, () => {
  beforeAll(async () => {
    context = await prepareBenchmark(root)
  }, 15_000)
  afterAll(async () => {
    await context?.cleanup()
  })
  // Register the entire proposed queue before any baseline can consume its watchdog.
  for (const descriptor of manifest) {
    it(
      descriptor.id,
      async () => {
        const record = await runDescriptor(context, descriptor)
        records.push(record)
        expect(record.id).toBe(descriptor.id)
      },
      15_000
    )
  }
  it('audits all completed proposed samples and attempted baseline cases', () => {
    const summary = auditResults(manifest, records)
    expect(summary.descriptors).toBe(manifest.length)
    expect(summary.scaling.every((item) => item.medianMs[1] <= 3 * item.medianMs[0] + 1)).toBe(true)
  })
})
