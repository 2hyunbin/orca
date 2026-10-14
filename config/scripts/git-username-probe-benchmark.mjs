import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'

// Run from the PR checkout: node config/scripts/git-username-probe-benchmark.mjs
const checkout = fileURLToPath(new URL('../../', import.meta.url))
const sourcePath = 'src/main/git/git-username.ts'
const baseRef = process.env.ORCA_PERF_BASE_REF ?? '7b915d587ed9688885afdba3503825adafb8eba4'
const iterations = Number(process.env.ORCA_PERF_BENCH_ITERATIONS ?? '21')
const gitBinary = process.env.ORCA_PERF_GIT_BINARY ?? 'git'
assert.ok(Number.isSafeInteger(iterations) && iterations > 0, 'Iterations must be positive.')
const processHostUrl = pathToFileURL(
  createRequire(import.meta.url).resolve('@orca/process-host')
).href
const root = await mkdtemp(join(tmpdir(), 'orca-username-probe-benchmark-'))
const emptyConfig = join(root, 'empty-config')
await writeFile(emptyConfig, '')
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: emptyConfig,
  GIT_CONFIG_NOSYSTEM: '1'
}

async function git(args, cwd = checkout) {
  const result = await runProcess({ program: gitBinary, args, cwd, env, timeoutMs: 5_000 })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.timedOut, false)
  assert.equal(result.outputTruncated, false)
  return result.stdout
}

async function compile(source, arm) {
  const filename = join(root, `${arm}.mjs`)
  await build({
    stdin: {
      contents: `${source}\nexport { benchmarkGitCalls } from './runner'\n`,
      resolveDir: resolve(checkout, 'src/main/git'),
      sourcefile: `${arm}.ts`,
      loader: 'ts'
    },
    outfile: filename,
    format: 'esm',
    platform: 'node',
    bundle: true,
    external: [processHostUrl],
    plugins: [
      {
        name: 'real-git-boundary',
        setup(builder) {
          builder.onResolve({ filter: /^\.\/runner$/ }, () => ({
            path: 'runner',
            namespace: 'bench'
          }))
          builder.onResolve({ filter: /^\.\/repo$/ }, () => ({ path: 'repo', namespace: 'bench' }))
          builder.onLoad({ filter: /^repo$/, namespace: 'bench' }, () => ({
            contents: `export { resolveDefaultBaseRefViaExec } from ${JSON.stringify(resolve(checkout, 'src/shared/git-default-base-ref.ts'))}`,
            resolveDir: checkout
          }))
          builder.onLoad({ filter: /^runner$/, namespace: 'bench' }, () => ({
            contents: `
            import { runProcess } from ${JSON.stringify(processHostUrl)}
            export const benchmarkGitCalls = []
            const benchEnv = {
              ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
              GIT_CONFIG_GLOBAL: ${JSON.stringify(emptyConfig)}, GIT_CONFIG_NOSYSTEM: '1'
            }
            export async function gitExecFileAsync(args, options = {}) {
              benchmarkGitCalls.push(args)
              const result = await runProcess({ program: ${JSON.stringify(gitBinary)}, args,
                cwd: options.cwd, env: benchEnv, timeoutMs: options.timeout,
                maxOutputBytes: 10 * 1024 * 1024 })
              if (result.code !== 0 || result.timedOut || result.outputTruncated) {
                throw Object.assign(new Error(result.stderr), result)
              }
              return result
            }
            export async function ghExecFileAsync() { throw new Error('Unexpected gh probe in offline fixture') }
            export function extractExecError() { return { stdout: '', stderr: '' } }
          `,
            resolveDir: checkout
          }))
        }
      }
    ]
  })
  return import(pathToFileURL(filename).href)
}

function percentile(samples, quantile) {
  const sorted = [...samples].sort((a, b) => a - b)
  return Number(sorted[Math.floor((sorted.length - 1) * quantile)].toFixed(3))
}

function sourceHash(source) {
  return createHash('sha256').update(source).digest('hex')
}

try {
  const baseline = await git(['show', `${baseRef}:${sourcePath}`])
  const afterSource = await readFile(join(checkout, sourcePath), 'utf8')
  assert.notEqual(baseline, afterSource, 'Baseline and current resolver sources must differ.')
  const modules = {
    before: await compile(baseline, 'before'),
    after: await compile(afterSource, 'after')
  }
  const scenarios = [
    { name: 'empty-remotes', commands: [], username: 'gitlab-user' },
    {
      name: 'gitlab-main',
      commands: [['config', 'branch.main.remote', 'origin']],
      remote: true,
      username: 'gitlab-user'
    },
    {
      name: 'gitlab-feature',
      commands: [
        ['checkout', '-b', 'feature'],
        ['config', 'branch.feature.remote', 'origin'],
        ['config', 'branch.main.remote', 'origin']
      ],
      remote: true,
      username: 'gitlab-user'
    },
    { name: 'gitlab-main-missing-remote', commands: [], remote: true, username: 'gitlab-user' },
    {
      name: 'gitlab-main-local-remote',
      commands: [['config', 'branch.main.remote', '.']],
      remote: true,
      username: 'gitlab-user'
    },
    {
      name: 'explicit-first-key',
      commands: [['config', 'github.user', 'explicit-user']],
      username: 'explicit-user'
    },
    {
      name: 'explicit-second-key',
      commands: [['config', 'user.username', 'explicit-user']],
      username: 'explicit-user'
    }
  ]
  const results = []
  for (const scenario of scenarios) {
    const repo = join(root, `repo with spaces ${scenario.name}`)
    const fixtureCommands = [
      ['init', '--quiet', repo],
      ['symbolic-ref', 'HEAD', 'refs/heads/main'],
      ['config', 'user.name', 'gitlab-user'],
      ['config', 'user.email', 'fixture@example.invalid'],
      ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'fixture'],
      ...(scenario.remote
        ? [['remote', 'add', 'origin', 'https://gitlab.example.invalid/team/repo.git']]
        : []),
      ...scenario.commands
    ]
    for (const args of fixtureCommands) {
      await git(args, args[0] === 'init' ? checkout : repo)
    }
    const samples = { before: [], after: [] }
    const counts = { before: new Set(), after: new Set() }
    const commands = {}
    for (let round = -3; round < iterations; round++) {
      for (const arm of round % 2 === 0 ? ['before', 'after'] : ['after', 'before']) {
        const module = modules[arm]
        module.benchmarkGitCalls.length = 0
        const started = performance.now()
        const answer = await module.resolveLocalGitUsernameDetailed(repo)
        const elapsed = performance.now() - started
        assert.deepEqual(answer, { username: scenario.username, authoritative: true })
        if (round >= 0) {
          samples[arm].push(elapsed)
          counts[arm].add(module.benchmarkGitCalls.length)
          commands[arm] ??= [...module.benchmarkGitCalls]
        }
      }
    }
    results.push({
      scenario: scenario.name,
      fixtureCommands,
      before: {
        p50Ms: percentile(samples.before, 0.5),
        p95Ms: percentile(samples.before, 0.95),
        gitCalls: [...counts.before],
        commands: commands.before
      },
      after: {
        p50Ms: percentile(samples.after, 0.5),
        p95Ms: percentile(samples.after, 0.95),
        gitCalls: [...counts.after],
        commands: commands.after
      },
      samples
    })
  }
  const report = {
    baseRef,
    sourcePath,
    beforeSourceSha256: sourceHash(baseline),
    afterSourceSha256: sourceHash(afterSource),
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    git: (await git(['--version'])).trim(),
    iterations,
    method:
      'Actual before/current resolver sources, shared unchanged default-base resolver, real Git through process-host, isolated offline config, three warmups, alternating paired order, expected username and authority checked on every sample. Timings cover this native resolver only.',
    results
  }
  if (process.env.ORCA_PERF_BENCH_OUTPUT) {
    await writeFile(
      resolve(process.env.ORCA_PERF_BENCH_OUTPUT),
      `${JSON.stringify(report, null, 2)}\n`
    )
  }
  console.log(JSON.stringify(report, (_key, value) => (_key === 'samples' ? undefined : value), 2))
} finally {
  await rm(root, { recursive: true, force: true })
}
