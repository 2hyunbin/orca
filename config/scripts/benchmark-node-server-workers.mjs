import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { runProcessSync } from '@orca/process-host'

assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'arm64')
assert(availableParallelism() >= 8, 'Comparison requires the eight-core ARM runner')
const root = resolve(import.meta.dirname, '../..')
const output = join(root, '.build/windows-native-benchmark/node-server-workers.json')
mkdirSync(join(root, '.build/windows-native-benchmark'), { recursive: true })
const measurements = []
// Reverse the second pair to expose warm filesystem effects.
for (const workers of [4, 8, 8, 4]) {
  const start = performance.now()
  const result = runProcessSync({
    program: process.execPath,
    args: ['config/scripts/run-node-server-tests.mjs', '--artifact'],
    cwd: root,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', VITEST_MAX_WORKERS: String(workers) },
    stdio: 'inherit',
    timeoutMs: null
  })
  measurements.push({ workers, seconds: (performance.now() - start) / 1000, code: result.code })
  writeFileSync(output, JSON.stringify({ source: process.env.SOURCE_SHA, measurements }, null, 2))
  assert.equal(result.code, 0, `Qualification failed with ${workers} workers`)
}
console.log(JSON.stringify(measurements, null, 2))
