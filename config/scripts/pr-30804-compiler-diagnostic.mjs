import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess } from '@orca/process-host'
import { measurePreflightCommand } from './preflight-benchmark-command.mjs'
import {
  TYPECHECK_PROJECTS,
  admissibleHeapGib,
  planTypecheckBatches,
  resolveProjectCompiler
} from './run-typecheck-projects-in-parallel.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const output = path.join(root, '.build/pr-30804-compiler-diagnostic')
const baseline = 'de7a2d24f9c3f2090bd39a672fc4ba555073eb67'
const mode = process.argv[2]
if (!['strict', 'head-node', 'baseline-node', 'windows-probe'].includes(mode)) {
  throw new Error('Choose strict, head-node, baseline-node or windows-probe')
}
mkdirSync(output, { recursive: true })
const report = {
  mode,
  sourceSha: process.env.GITHUB_SHA,
  baseline,
  versions: process.versions,
  memoryBytes: totalmem(),
  cores: availableParallelism(),
  plannedBatches: planTypecheckBatches(TYPECHECK_PROJECTS, {
    budgetGib: Math.min(12, admissibleHeapGib(totalmem())),
    parallelism: Math.min(4, availableParallelism())
  })
}
const save = () => {
  writeFileSync(path.join(output, `${mode}.json`), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report))
}
save()
let tree = root
if (mode === 'baseline-node' || mode === 'windows-probe') {
  tree = mkdtempSync(path.join(output, 'baseline-'))
  const archive = path.join(output, `${mode}.tar`)
  for (const [program, args] of [
    ['git', ['archive', '--format=tar', '--output', archive, baseline]],
    ['tar', ['-xf', archive, '-C', tree]]
  ]) {
    const result = await runProcess({ program, args, cwd: root, timeoutMs: 120_000 })
    if (result.code !== 0) {
      throw new Error(`${program} failed: ${result.stderr}`)
    }
  }
  rmSync(archive)
}
const config =
  mode === 'strict' ? 'config/tsconfig.terminal-interface.test.json' : 'config/tsconfig.node.json'
if (mode === 'windows-probe') {
  const directory = mkdtempSync(path.join(tree, 'src/main/pr-30804-probe-'))
  writeFileSync(
    path.join(directory, 'preflight-typecheck-benchmark-probe.ts'),
    [
      'export const preflightBenchmarkValue: number = "typecheck must reject this"',
      'export function preflightBenchmarkReturn(value: number): string { return value }',
      'export const preflightBenchmarkNull: string = null',
      'export function preflightBenchmarkImplicit(value) { return value }'
    ].join('\n')
  )
}
for (const project of TYPECHECK_PROJECTS) {
  rmSync(path.join(tree, project.config.replace(/\.json$/, '.tsbuildinfo')), { force: true })
}
const compiler = resolveProjectCompiler(config, root)
report.command = [process.execPath, compiler, '--noEmit', '-p', config, '--pretty', 'false']
report.compilerVersion = JSON.parse(
  readFileSync(path.join(root, 'node_modules/typescript/package.json'))
).version
save()
report.result = await measurePreflightCommand({
  program: process.execPath,
  args: report.command.slice(1),
  label: mode,
  root: tree,
  output,
  env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', GOMAXPROCS: '4' },
  timeoutMs: mode === 'windows-probe' ? 900_000 : 240_000
})
save()
const result = report.result
const diagnostics = `${result.stdout}${result.stderr}`.match(/: error TS2322:/g) ?? []
if (
  result.timedOut ||
  result.signal ||
  result.code !== (mode === 'windows-probe' ? 1 : 0) ||
  (mode === 'windows-probe' && diagnostics.length !== 3)
) {
  throw new Error(`Compiler diagnostic failed: ${mode}`)
}
