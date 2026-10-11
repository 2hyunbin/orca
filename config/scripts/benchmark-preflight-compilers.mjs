import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { runProcess } from '@orca/process-host'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'
import {
  TYPECHECK_PROJECTS,
  admissibleHeapGib,
  planTypecheckBatches,
  resolveProjectCompiler
} from './run-typecheck-projects-in-parallel.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const output = path.join(root, '.build/preflight-benchmark')
mkdirSync(output, { recursive: true })
const bun = process.env.ORCA_BENCHMARK_BUN ?? 'bun'
const env = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', GOMAXPROCS: '4' }
const report = {
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    memoryBytes: totalmem(),
    cores: availableParallelism()
  },
  method:
    'Four counterbalanced pairs per comparison. Cold removes build state, not filesystem caches. Warm immediately follows its cold run. Same commit and project registry for every arm.',
  measurements: [],
  comparisons: {},
  parity: []
}
const save = () =>
  writeFileSync(path.join(output, 'compilers.json'), `${JSON.stringify(report, null, 2)}\n`)
async function command(program, args, label) {
  const timeFile = path.join(output, `${label}.resources.txt`)
  const start = performance.now()
  const result = await runProcess({
    program: process.platform === 'linux' ? '/usr/bin/time' : program,
    args: process.platform === 'linux' ? ['-v', '-o', timeFile, program, ...args] : args,
    cwd: root,
    env,
    timeoutMs: 240_000,
    maxOutputBytes: 8 * 1024 * 1024
  })
  const resources = process.platform === 'linux' ? readFileSync(timeFile, 'utf8') : ''
  const peakRssKiB =
    Number(resources.match(/Maximum resident set size \(kbytes\): (\d+)/)?.[1]) || null
  return { ...result, durationMs: performance.now() - start, peakRssKiB }
}
const version = await command(bun, ['--version'], 'bun-version')
if (version.code !== 0 || version.stdout.trim() !== '1.4.3') {
  throw new Error('Pin Bun 1.4.3 for this comparison')
}
report.host.bun = version.stdout.trim()
report.host.typescript = JSON.parse(
  readFileSync(path.join(root, 'node_modules/typescript/package.json'))
).version
const nativeBatches = planTypecheckBatches(TYPECHECK_PROJECTS, {
  budgetGib: Math.min(12, admissibleHeapGib(totalmem())),
  parallelism: Math.min(4, availableParallelism())
})
function invocation(config, arm, extra = []) {
  return arm === 'native'
    ? [
        process.execPath,
        [
          resolveProjectCompiler(config, root),
          '--noEmit',
          '-p',
          config,
          '--pretty',
          'false',
          ...extra
        ]
      ]
    : [
        bun,
        [
          'check',
          '-p',
          config,
          '--threads',
          arm === 'bun-pair' ? '2' : '4',
          '--no-pretty',
          '--all',
          ...extra
        ]
      ]
}
async function suite(arm, state, pair, comparison) {
  const batches =
    arm === 'native'
      ? nativeBatches
      : arm === 'bun-pair'
        ? [TYPECHECK_PROJECTS.slice(0, 2), TYPECHECK_PROJECTS.slice(2)]
        : TYPECHECK_PROJECTS.map((project) => [project])
  const start = performance.now()
  const projects = []
  for (const batch of batches) {
    projects.push(
      ...(await Promise.all(
        batch.map(async ({ config }) => {
          const [program, args] = invocation(config, arm)
          return {
            config,
            ...(await command(
              program,
              args,
              `${comparison}-${pair}-${arm}-${state}-${path.basename(config)}`
            ))
          }
        })
      ))
    )
  }
  const measurement = {
    comparison,
    pair,
    arm,
    state,
    durationMs: performance.now() - start,
    projects
  }
  report.measurements.push(measurement)
  save()
  console.log(
    JSON.stringify({
      comparison,
      pair,
      arm,
      state,
      durationMs: measurement.durationMs,
      codes: projects.map((project) => project.code),
      peakRssKiB: projects.map((project) => project.peakRssKiB)
    })
  )
  if (projects.some((project) => project.code !== 0 || project.timedOut || project.signal)) {
    throw new Error(`Compiler failed: ${JSON.stringify(projects)}`)
  }
}
function clearBuildState() {
  for (const { config } of TYPECHECK_PROJECTS) {
    rmSync(path.join(root, config.replace(/\.json$/, '.tsbuildinfo')), { force: true })
  }
}
for (const [comparison, first, second] of [
  ['native-vs-bun', 'native', 'bun'],
  ['bun-serial-vs-pair', 'bun', 'bun-pair']
]) {
  for (const [pair, arms] of buildCounterbalancedSchedule(4, first, second).entries()) {
    for (const arm of arms) {
      clearBuildState()
      await suite(arm, arm === 'native' ? 'cold' : 'full', pair, comparison)
      if (arm === 'native') {
        await suite(arm, 'warm', pair, comparison)
      }
    }
  }
  report.comparisons[comparison] = {}
  for (const arm of [first, second]) {
    for (const state of arm === 'native' ? ['cold', 'warm'] : ['full']) {
      const samples = report.measurements.filter(
        (sample) => sample.comparison === comparison && sample.arm === arm && sample.state === state
      )
      report.comparisons[comparison][`${arm}-${state}`] = summarizeBenchmarkSamples(
        samples.map((sample) => sample.durationMs)
      )
    }
  }
  save()
}
// Override only the root-file selection; retain each project's actual compiler options.
for (const { config } of TYPECHECK_PROJECTS) {
  const directory = mkdtempSync(
    path.join(path.dirname(path.join(root, config)), '.preflight-probe-')
  )
  const probe = path.join(directory, 'preflight-typecheck-benchmark-probe.ts')
  const probeConfig = path.join(directory, 'tsconfig.preflight-benchmark-probe.json')
  if (readFileSync(path.join(root, config), 'utf8').includes('preflight-benchmark-probe')) {
    throw new Error('Unexpected probe reference')
  }
  try {
    writeFileSync(
      probe,
      'export const preflightBenchmarkValue: number = "typecheck must reject this"\n',
      { flag: 'wx' }
    )
    writeFileSync(
      probeConfig,
      JSON.stringify({
        extends: `../${path.basename(config)}`,
        include: [path.basename(probe)],
        exclude: [],
        compilerOptions: { incremental: false, composite: false }
      }),
      { flag: 'wx' }
    )
    const relativeConfig = path.relative(root, probeConfig)
    for (const arm of ['native', 'bun']) {
      const [program, args] = invocation(relativeConfig, arm)
      const result = await command(program, args, `probe-${path.basename(config)}-${arm}`)
      report.parity.push({ config, arm, ...result })
      save()
      if (result.code !== 1 || !`${result.stdout}${result.stderr}`.includes('TS2322')) {
        throw new Error(`Missing expected diagnostic: ${arm} ${config}`)
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  for (const arm of ['native', 'bun']) {
    const [program, args] = invocation(config, arm, ['--listFilesOnly'])
    const result = await command(program, args, `files-${path.basename(config)}-${arm}`)
    if (result.code !== 0) {
      throw new Error(`Could not enumerate ${arm} ${config}: ${result.stderr}`)
    }
    report.parity.push({
      config,
      arm,
      files: result.stdout
        .split(/\r?\n/)
        .filter((line) => path.isAbsolute(line.trim()))
        .map((line) => path.normalize(line.trim()))
        .sort()
    })
  }
  const [nativeFiles, bunFiles] = report.parity
    .filter((sample) => sample.config === config && sample.files)
    .map((sample) => sample.files)
  if (JSON.stringify(nativeFiles) !== JSON.stringify(bunFiles)) {
    throw new Error(`Compiler file selection differs: ${config}`)
  }
  save()
}
const summary = `Compiler comparison on ${process.platform}/${process.arch}, ${report.host.cores} cores\n\n\`\`\`json\n${JSON.stringify(report.comparisons, null, 2)}\n\`\`\`\n\nAll project file lists match; both compilers reject the assignment-error probe in every project.\n`
writeFileSync(path.join(output, 'compilers.md'), summary)
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' })
}
