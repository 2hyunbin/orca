// Run: ORCA_BACKGROUND_LAUNCH=1 node config/scripts/terminal-shell-lifecycle-retention-benchmark.mjs [baseline-ref]
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { runProcessSync } from '@orca/process-host'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { describeProcessFailure } from './process-failure-message.mjs'

const root = resolve(import.meta.dirname, '../..')
const sourcePath = 'src/main/daemon/terminal-shell-lifecycle-scanner.ts'
const digest = (value) => createHash('sha256').update(value).digest('hex')
const pending = '\x1bPq1234567890;\ud800a\udfff\u0000漢'
const median = (values) =>
  values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)]

function execute(program, args) {
  const result = runProcessSync({
    program,
    args,
    cwd: root,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 120000,
    maxOutputBytes: 4 * 1024 * 1024
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error(describeProcessFailure(result))
  }
  return result.stdout
}

function heapAfterGc() {
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

async function runWorker() {
  assert.equal(typeof globalThis.gc, 'function', 'Worker requires --expose-gc')
  const { TerminalShellLifecycleScanner, ownRetainedString, resetOwnRetainedStringCopier } =
    await import(pathToFileURL(process.argv[3]).href)
  const withoutBuffer = process.argv[4] === 'without-buffer'
  resetOwnRetainedStringCopier()
  const originalBuffer = globalThis.Buffer
  if (withoutBuffer) {
    delete globalThis.Buffer
  }
  try {
    assert.equal(ownRetainedString(pending), pending)
  } finally {
    globalThis.Buffer = originalBuffer
  }

  const privateMode = '\x1b[?1049;2004;1000;'
  const commandFinished = '\x1b]133;D;137;\ud800a\udfff\u0000漢'
  const memory = []
  for (const [name, tail] of [
    ['DECSET', privateMode],
    ['OSC 133', commandFinished]
  ]) {
    void /reset/.test('reset')
    const before = heapAfterGc()
    const scanners = Array.from({ length: 8 }, (_value, index) => {
      const scanner = new TerminalShellLifecycleScanner()
      scanner.seedOwner('shell', { alternateScreen: tail === commandFinished })
      scanner.scan(`${index}:${'x'.repeat(4 * 1024 * 1024)}${tail}`)
      return scanner
    })
    const retainedWithRegexInput = heapAfterGc() - before
    void /reset/.test('reset')
    const retainedByScanners = heapAfterGc() - before
    const outcomes = []
    for (const scanner of scanners) {
      assert.equal(scanner.owner, 'shell')
      const events = scanner.scan(tail === privateMode ? '1006h' : '\x07remaining')
      assert.equal(scanner.owner, undefined)
      assert.equal(scanner.isAlternateScreenActive, true)
      outcomes.push({ events, generation: scanner.generation })
    }
    memory.push({
      name,
      logicalTailUnits: scanners.length * tail.length,
      retainedWithRegexInput,
      retainedByScanners,
      outcomes
    })
  }

  const scenarios = [
    ['single-character echo', 'x', 200000],
    ['16 KiB plain output', 'x'.repeat(16 * 1024), 10000],
    ['16 KiB colored output', '\x1b[32mgreen!\x1b[0m\n'.repeat(1024), 1000],
    ['whole pending command', privateMode, 20000],
    ['16 KiB output with pending command', `${'x'.repeat(16 * 1024)}${privateMode}`, 10000],
    [
      '16 KiB output with 4096-unit pending command',
      `${'x'.repeat(16 * 1024)}\x1b[?${'1;'.repeat(2046)}1`,
      1000
    ]
  ]
  const timings = []
  let checksum = 0
  for (const [name, chunk, calls] of scenarios) {
    const scanner = new TerminalShellLifecycleScanner()
    const samples = []
    for (let sample = 0; sample < 5; sample += 1) {
      const start = performance.now()
      for (let index = 0; index < calls; index += 1) {
        checksum += Object.keys(scanner.scan(chunk)).length
      }
      samples.push(performance.now() - start)
    }
    timings.push({ name, calls, medianMs: median(samples.slice(2)) })
  }
  process.stdout.write(`${JSON.stringify({ withoutBuffer, memory, checksum, timings })}\n`)
}

async function runComparison() {
  const baselineCommit = execute('git', [
    'rev-parse',
    '--verify',
    `${process.argv[2] ?? 'HEAD'}^{commit}`
  ]).trim()
  const temporary = mkdtempSync(join(tmpdir(), 'orca-partial-escape-retention-'))
  const sources = {}
  const bundles = {}
  try {
    for (const arm of ['baseline', 'current']) {
      const hashes = new Map()
      const bundlePath = join(temporary, `${arm}.mjs`)
      await build({
        stdin: {
          contents: `export * from './${sourcePath}'; export {ownRetainedString, resetOwnRetainedStringCopier} from './src/shared/own-retained-string.ts';`,
          resolveDir: root
        },
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: bundlePath,
        logLevel: 'silent',
        plugins: [
          {
            name: 'pinned-production-sources',
            setup(builder) {
              builder.onLoad({ filter: /\.ts$/ }, ({ path }) => {
                const projectPath = relative(root, path).split(sep).join('/')
                const contents =
                  arm === 'baseline'
                    ? execute('git', ['show', `${baselineCommit}:${projectPath}`])
                    : readFileSync(path, 'utf8')
                hashes.set(projectPath, digest(contents))
                return { contents, resolveDir: dirname(path), loader: 'ts' }
              })
            }
          }
        ]
      })
      bundles[arm] = bundlePath
      sources[arm] = {
        files: Object.fromEntries(hashes),
        bundleSha256: digest(readFileSync(bundlePath))
      }
    }
    const schedule = buildCounterbalancedSchedule(6, 'baseline', 'current')
    const measurements = []
    for (let round = 0; round < schedule.length; round += 1) {
      for (const mode of ['with-buffer', 'without-buffer']) {
        const pair = []
        for (const arm of schedule[round]) {
          const result = JSON.parse(
            execute(process.execPath, [
              '--expose-gc',
              import.meta.filename,
              '--worker',
              bundles[arm],
              mode
            ])
          )
          pair.push(result)
          measurements.push({ round: round + 1, arm, ...result })
        }
        assert.equal(pair[0].checksum, pair[1].checksum)
        assert.deepEqual(
          pair[0].memory.map(({ name, logicalTailUnits, outcomes }) => ({
            name,
            logicalTailUnits,
            outcomes
          })),
          pair[1].memory.map(({ name, logicalTailUnits, outcomes }) => ({
            name,
            logicalTailUnits,
            outcomes
          }))
        )
      }
    }
    const summaries = []
    for (const withoutBuffer of [false, true]) {
      for (const arm of ['baseline', 'current']) {
        const rows = measurements.filter(
          (row) => row.arm === arm && row.withoutBuffer === withoutBuffer
        )
        summaries.push({
          arm,
          withoutBuffer,
          memory: rows[0].memory.map(({ name, logicalTailUnits }, index) => ({
            name,
            logicalTailUnits,
            retainedWithRegexInput: median(
              rows.map((row) => row.memory[index].retainedWithRegexInput)
            ),
            retainedByScanners: median(rows.map((row) => row.memory[index].retainedByScanners))
          })),
          timings: rows[0].timings.map(({ name, calls }, index) => ({
            name,
            calls,
            medianMs: median(rows.map((row) => row.timings[index].medianMs))
          }))
        })
      }
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          baselineCommit,
          environment: {
            node: process.version,
            v8: process.versions.v8,
            platform: process.platform,
            architecture: process.arch
          },
          metric:
            'Retained heap after two forced full GCs with eight scanner owners held alive. Both the whole retained heap and scanner-owned storage after resetting the separate V8 process-wide regexp input root are reported. CPU timings exclude GC. Fresh worker per arm, copier and round. Bufferless copying is the production fallback in Node, not a physical renderer or phone measurement.',
          parentUnitsEach: 4 * 1024 * 1024,
          schedule,
          sources,
          summaries,
          measurements
        },
        null,
        2
      )}\n`
    )
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

await (process.argv[2] === '--worker' ? runWorker() : runComparison())
