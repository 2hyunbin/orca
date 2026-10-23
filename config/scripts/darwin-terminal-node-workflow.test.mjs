import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

function workflow(name) {
  return parse(
    readFileSync(join(import.meta.dirname, '../../.github/workflows', `${name}.yml`), 'utf8')
  )
}

it.each([
  'config/node-runtime-patches/darwin-worker-wait.patch',
  'config/scripts/build-darwin-terminal-node.mjs',
  'config/scripts/pr-darwin-terminal-node-route.mjs',
  'config/scripts/verify-darwin-terminal-node.mjs',
  'config/scripts/darwin-terminal-node-probe.cjs',
  'config/scripts/__fixtures__/darwin-threadpool-wait.h',
  'config/scripts/macos-terminal-host-bundle.cjs',
  'src/shared/node-runtime-pin.ts'
])('qualifies the actual macOS runtime when %s changes', (file) => {
  expect(classifyPrJobs([file]).darwin_terminal_node).toBe(true)
})

it('does not source-build Node for unrelated renderer changes', () => {
  expect(classifyPrJobs(['src/renderer/src/App.tsx']).darwin_terminal_node).toBe(false)
})

it.each(['adhoc', 'daily', 'hourly', 'release'])(
  'builds both %s runtime architectures after installing build dependencies',
  (channel) => {
    const jobs = Object.values(workflow(`${channel}-mac-build`).jobs)
    const steps = jobs.find((job) =>
      job.steps?.some((step) => step.name === 'Build the patched terminal runtimes')
    ).steps
    const build = steps.findIndex((step) => step.name === 'Build the patched terminal runtimes')
    expect(build).toBeGreaterThan(steps.findIndex((step) => step.name === 'Install dependencies'))
    expect(steps[build].run).toContain('build-darwin-terminal-node.mjs arm64')
    expect(steps[build].run).toContain('build-darwin-terminal-node.mjs x64')
    if (channel === 'daily') {
      expect(steps[build].if).toBe("steps.freshness.outputs.should_build == 'true'")
    }
  }
)

it.skipIf(process.platform === 'win32').each([
  ['success', 'true', 0],
  ['failure', 'true', 1],
  ['cancelled', 'true', 1],
  ['skipped', 'true', 1],
  ['', 'true', 1],
  ['skipped', 'false', 0]
])('aggregate handles runtime result %s (required=%s)', async (result, required, code) => {
  const gate = workflow('pr').jobs.verify.steps.find(
    (step) => step.name === 'Require successful checks'
  )
  const env = Object.fromEntries(
    Object.keys(gate.env).map((key) => [key, key.endsWith('_SHOULD_RUN') ? 'true' : 'success'])
  )
  const checked = await runProcess({
    program: 'bash',
    args: ['-c', gate.run],
    env: {
      ...process.env,
      ...env,
      SHOULD_RUN: 'true',
      DARWIN_TERMINAL_NODE: result,
      DARWIN_TERMINAL_NODE_SHOULD_RUN: required
    },
    timeoutMs: 10_000
  })
  expect(checked.code).toBe(code)
})

it('classifies runtime changes from the dependency-free CI sparse checkout', async () => {
  const root = join(import.meta.dirname, '../..')
  const directory = mkdtempSync(join(tmpdir(), 'orca-runtime-sparse-checkout-'))
  try {
    const checkout = workflow('pr').jobs.code_paths.steps.find(
      (step) => step.with?.['sparse-checkout']
    )
    for (const entry of checkout.with['sparse-checkout'].trim().split('\n')) {
      const path = entry.trim().replace(/^\//, '')
      const source = join(root, path)
      if (statSync(source).isFile()) {
        const destination = join(directory, path)
        mkdirSync(dirname(destination), { recursive: true })
        copyFileSync(source, destination)
      }
    }
    const result = await runProcess({
      program: process.execPath,
      args: ['config/scripts/pr-code-change-scope.mjs'],
      cwd: directory,
      input: 'config/node-runtime-patches/darwin-worker-wait.patch\n',
      timeoutMs: 10_000
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('darwin_terminal_node=true')
    expect(result.stdout).toContain('package_windows=false')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
