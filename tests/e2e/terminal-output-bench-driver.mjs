// Alternates two prebuilt app trees (out-main, out-p9) through terminal-output-bench.spec.ts.
// usage: node tests/e2e/terminal-output-bench-driver.mjs <runs> <report.jsonl> [group]
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'

const [runs = '5', report = 'bench-results/output-bench.jsonl', group = 'all'] =
  process.argv.slice(2)
const root = path.resolve(import.meta.dirname, '../..')
const reportPath = path.resolve(report)
mkdirSync(path.dirname(reportPath), { recursive: true })
const builds = ['main', 'p9']
for (let i = 0; i < Number(runs); i += 1) {
  const order = i % 2 === 0 ? builds : builds.toReversed()
  for (const build of order) {
    const tree = path.join(root, `out-${build}`)
    const out = path.join(root, 'out')
    if (existsSync(out)) throw new Error('out/ already exists; restore out-main/out-p9 first')
    renameSync(tree, out)
    try {
      console.log(`[output-bench-driver] run ${i + 1}/${runs} build ${build}`)
      const result = spawnSync(
        process.platform === 'win32' ? 'npx.cmd' : 'npx',
        [
          'playwright',
          'test',
          'tests/e2e/terminal-output-bench.spec.ts',
          '--config',
          'tests/playwright.config.ts',
          '--project',
          'electron-headless',
          '--workers=1',
          '--reporter=line'
        ],
        {
          cwd: root,
          stdio: 'inherit',
          shell: process.platform === 'win32',
          env: {
            ...process.env,
            SKIP_BUILD: '1',
            ORCA_BACKGROUND_LAUNCH: '1',
            ORCA_OUTPUT_BENCH_LABEL: build,
            ORCA_OUTPUT_BENCH_RUN: String(i),
            ORCA_OUTPUT_BENCH_REPORT: reportPath,
            ORCA_OUTPUT_BENCH_GROUP: group
          }
        }
      )
      console.log(`[output-bench-driver] exit ${result.status}`)
    } finally {
      renameSync(out, tree)
    }
  }
}
