import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  activateCompilerCache,
  compilerCacheIdentity,
  packCompilerCache
} from './headless-detector-compiler-cache.mjs'
import { collectNodeServerInputs } from './node-server-change-scope.mjs'
import { runProcessSync } from '@orca/process-host'

const temporary = []
afterEach(() => {
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'headless-compiler-cache-'))
  temporary.push(directory)
  const root = join(directory, 'checkout')
  mkdirSync(root)
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  const identity = compilerCacheIdentity({ policyHash: 'policy', cacheRoot: directory })
  packCompilerCache({ identity })
  return { root, identity }
}
function changeManifest(identity, update) {
  const path = join(identity.path, 'manifest.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  update(manifest)
  writeFileSync(path, JSON.stringify(manifest))
}

it('separates policy, Node, platform and architecture identities with the same archive path', () => {
  const options = {
    policyHash: 'policy',
    cacheRoot: '/cache',
    platform: 'linux',
    arch: 'x64',
    node: 'v24.21.0'
  }
  const original = compilerCacheIdentity(options)
  for (const override of [
    { policyHash: 'changed' },
    { node: 'v24.22.0' },
    { platform: 'darwin' },
    { arch: 'arm64' }
  ]) {
    const other = compilerCacheIdentity({ ...options, ...override })
    expect(other.key).not.toBe(original.key)
    expect(other.path).toBe(original.path)
  }
})

it('activates the compiler and workspace-policy parser and preserves import graph behavior', async () => {
  const { root, identity } = fixture()
  expect(await activateCompilerCache({ root, identity })).toEqual({ available: true })
  expect(readdirSync(join(root, 'node_modules')).sort()).toEqual(['@esbuild', 'esbuild', 'yaml'])
  for (const name of [
    'node-server-change-scope',
    'node-server-test-paths',
    'node-server-qualification',
    'orcad-entry-build',
    'workspace-source-exports'
  ]) {
    mkdirSync(join(root, 'config', 'scripts'), { recursive: true })
    cpSync(
      new URL(`./${name}.mjs`, import.meta.url),
      join(root, 'config', 'scripts', `${name}.mjs`)
    )
  }
  mkdirSync(join(root, 'src', 'shared'), { recursive: true })
  cpSync(
    new URL('../../src/shared/orcad-artifacts.ts', import.meta.url),
    join(root, 'src', 'shared', 'orcad-artifacts.ts')
  )
  writeFileSync(
    join(root, 'entry.ts'),
    "import './first'; export * from './exports'; import('./dynamic'); require('./required'); import 'external-package'; import './native.node'; import '@orca/process-host'"
  )
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - src/packages/*\n')
  mkdirSync(join(root, 'src/packages/process-host/src'), { recursive: true })
  writeFileSync(
    join(root, 'src/packages/process-host/package.json'),
    JSON.stringify({
      name: '@orca/process-host',
      exports: { '.': { 'orca-source': './src/run-process.ts', default: './dist/run-process.js' } }
    })
  )
  writeFileSync(
    join(root, 'src/packages/process-host/src/run-process.ts'),
    'export const value = 1'
  )
  for (const name of ['first', 'exports', 'dynamic', 'required']) {
    writeFileSync(join(root, `${name}.ts`), 'export const value = 1')
  }
  writeFileSync(
    join(root, 'probe.mjs'),
    "import { collectNodeServerInputs } from './config/scripts/node-server-change-scope.mjs'; console.log(JSON.stringify([...(await collectNodeServerInputs({ root: process.cwd(), entryPoints: ['entry.ts'] }))].sort()))"
  )
  const baseline = [...(await collectNodeServerInputs({ root, entryPoints: ['entry.ts'] }))].sort()
  expect(baseline).toContain('src/packages/process-host/src/run-process.ts')
  expect(baseline).toContain('src/packages/process-host/package.json')
  const candidate = runProcessSync({
    program: process.execPath,
    args: ['probe.mjs'],
    cwd: root,
    timeoutMs: 10_000
  })
  expect(candidate.code, candidate.stderr).toBe(0)
  expect(JSON.parse(candidate.stdout.trim())).toEqual(baseline)
}, 20_000)

it.each(['key', 'node', 'version', 'files'])(
  'falls back on invalid manifest %s and cleans partial activation',
  async (field) => {
    const { root, identity } = fixture()
    changeManifest(identity, (manifest) => {
      manifest[field] = 'wrong'
    })
    expect((await activateCompilerCache({ root, identity })).available).toBe(false)
    expect(existsSync(join(root, 'node_modules'))).toBe(false)
  }
)

it.each(['modified', 'missing', 'extra', 'symlink', 'malformed'])(
  'falls back on %s cache contents before loading code',
  async (kind) => {
    const { root, identity } = fixture()
    const compiler = join(identity.path, 'node_modules', 'esbuild', 'lib', 'main.js')
    if (kind === 'modified') {
      appendFileSync(compiler, '\nthrow Error("must not load")')
    }
    if (kind === 'missing') {
      rmSync(compiler)
    }
    if (kind === 'extra') {
      writeFileSync(join(identity.path, 'unexpected'), 'extra')
    }
    if (kind === 'symlink') {
      rmSync(compiler)
      symlinkSync(join(root, 'package.json'), compiler)
    }
    if (kind === 'malformed') {
      writeFileSync(join(identity.path, 'manifest.json'), '{')
    }
    expect((await activateCompilerCache({ root, identity })).available).toBe(false)
    expect(existsSync(join(root, 'node_modules'))).toBe(false)
  }
)

it('leaves existing dependencies alone and falls back on an absent archive', async () => {
  const { root, identity } = fixture()
  rmSync(identity.path, { recursive: true })
  expect((await activateCompilerCache({ root, identity })).available).toBe(false)
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'node_modules', 'retained'), 'retained')
  expect((await activateCompilerCache({ root, identity })).available).toBe(false)
  expect(readFileSync(join(root, 'node_modules', 'retained'), 'utf8')).toBe('retained')
})

it('expands the same sparse detector commit before loading local graph inputs', () => {
  const workflow = parse(readFileSync('.github/workflows/node-server-tests.yml', 'utf8'))
  const steps = workflow.jobs.changes.steps
  const checkouts = steps.filter((step) => step.uses === 'actions/checkout@v6')
  expect(checkouts).toHaveLength(2)
  const [source, expansion] = checkouts
  expect(source.id).toBe('source')
  expect(source.with.filter).toBe('blob:none')
  expect(source.with['sparse-checkout-cone-mode']).toBe(false)
  expect(source.with['sparse-checkout'].trim().split('\n')).toEqual([
    '/package.json',
    '/config/scripts/node-server-change-scope.mjs',
    '/config/scripts/node-server-test-paths.mjs',
    '/config/scripts/node-server-qualification.mjs'
  ])
  for (const checkout of checkouts) {
    expect(checkout.with['fetch-depth']).toBe(2)
    expect(checkout.with['persist-credentials']).toBe(false)
    expect(checkout['continue-on-error']).toBeUndefined()
  }
  expect(expansion.if).toBe("steps.scope.outputs.graph_required == 'true'")
  expect(expansion.with.ref).toBe('${{ steps.source.outputs.commit }}')
  expect(expansion.with.filter).toBeUndefined()
  expect(expansion.with['sparse-checkout']).toBe('/**')
  expect(expansion.with['sparse-checkout-cone-mode']).toBe(false)
  const scope = steps.find((step) => step.id === 'scope')
  expect(steps.indexOf(source)).toBeLessThan(steps.indexOf(scope))
  expect(steps.indexOf(expansion)).toBeGreaterThan(steps.indexOf(scope))
  const consumers = steps.filter((step) => step.uses?.startsWith('./') || step.id === 'graph')
  expect(consumers.map((step) => step.id ?? step.uses)).toContain('graph')
  for (const consumer of consumers) {
    expect(steps.indexOf(consumer)).toBeGreaterThan(steps.indexOf(expansion))
  }
})

it('restores every tracked byte before loading local actions from the sparse detector', () => {
  const workflow = parse(readFileSync('.github/workflows/node-server-tests.yml', 'utf8'))
  const [source, expansion] = workflow.jobs.changes.steps.filter(
    (step) => step.uses === 'actions/checkout@v6'
  )
  const root = mkdtempSync(join(tmpdir(), 'headless-checkout-'))
  temporary.push(root)
  const git = (...args) => {
    const result = runProcessSync({ program: 'git', args: ['-C', root, ...args], timeoutMs: 5_000 })
    expect(result.code, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  const manifests = [
    '.github/actions/prepare-headless-compiler/action.yml',
    '.github/actions/install-node-dependencies/action.yml',
    '.github/actions/restore-pnpm-verification/action.yml',
    '.github/actions/prepare-native-runtime/action.yml'
  ]
  const files = Object.fromEntries(
    [
      ...source.with['sparse-checkout']
        .trim()
        .split('\n')
        .map((path) => path.slice(1)),
      ...manifests
    ].map((path) => [path, readFileSync(path)])
  )
  files['src/deep/.hidden/source.bin'] = Buffer.from([0, 1, 255])
  files['nested/space name.txt'] = Buffer.from('all source paths')
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), bytes)
  }
  git('init')
  git('config', 'core.autocrlf', 'false')
  git('add', '--all')
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=.git/hooks',
    'commit',
    '-m',
    'fixture'
  )
  const commit = git('rev-parse', 'HEAD')
  const sparse = join(root, '.git/info/sparse-checkout')
  mkdirSync(join(sparse, '..'), { recursive: true })
  git('config', 'core.sparseCheckout', 'true')
  writeFileSync(sparse, source.with['sparse-checkout'])
  git('checkout', '--force', '--detach', commit)
  for (const manifest of manifests) {
    expect(existsSync(join(root, manifest))).toBe(false)
  }
  if (expansion.with['sparse-checkout']) {
    appendFileSync(sparse, `\n${expansion.with['sparse-checkout']}\n`)
  } else {
    git('sparse-checkout', 'disable')
    runProcessSync({
      program: 'git',
      args: ['-C', root, 'config', '--local', '--unset-all', 'extensions.worktreeConfig'],
      timeoutMs: 5_000
    })
  }
  git('checkout', '--force', '--detach', commit)
  expect(git('rev-parse', 'HEAD')).toBe(commit)
  for (const [path, bytes] of Object.entries(files)) {
    expect(readFileSync(join(root, path)), path).toEqual(bytes)
  }
  expect(
    git('ls-files', '-t')
      .split('\n')
      .some((line) => line.startsWith('S '))
  ).toBe(false)
  expect(git('status', '--porcelain')).toBe('')
})

it('uses exact optional restores, seeds only main and retains full dependency fallback', () => {
  const action = parse(readFileSync('.github/actions/prepare-headless-compiler/action.yml', 'utf8'))
  const steps = action.runs.steps
  const restore = steps.find((step) => step.id === 'cache')
  expect(restore.uses).toBe('actions/cache/restore@v5')
  expect(restore['continue-on-error']).toBe(true)
  expect(restore.with['restore-keys']).toBeUndefined()
  const save = steps.find((step) => step.uses === 'actions/cache/save@v5')
  expect(save.if).toContain("github.ref == 'refs/heads/main'")
  expect(save.if).toContain("github.event_name != 'pull_request'")
  expect(save['continue-on-error']).toBe(true)
  expect(save.with).toEqual(restore.with)
  const workflow = parse(readFileSync('.github/workflows/node-server-tests.yml', 'utf8'))
  const detector = workflow.jobs.changes.steps
  const cached = detector.find((step) => step.id === 'compiler')
  expect(cached.if).toBe("steps.scope.outputs.graph_required == 'true'")
  expect(cached['continue-on-error']).toBe(true)
  expect(
    detector.find((step) => step.uses === './.github/actions/install-node-dependencies').if
  ).toBe(
    "steps.scope.outputs.graph_required == 'true' && steps.compiler.outputs.available != 'true'"
  )
  expect(workflow.on.pull_request.paths).toContain('.github/actions/prepare-headless-compiler/**')
  const warmer = parse(readFileSync('.github/workflows/ci-cache-warmup.yml', 'utf8'))
  const warmSteps = warmer.jobs.warm.steps
  expect(
    warmSteps.findIndex((step) => step.uses === './.github/actions/prepare-headless-compiler')
  ).toBeGreaterThan(
    warmSteps.findIndex((step) => step.uses === './.github/actions/install-node-dependencies')
  )
  for (const event of ['push', 'pull_request']) {
    expect(warmer.on[event].paths).toContain('.github/actions/prepare-headless-compiler/**')
  }
  const inputs = [
    ...steps.find((step) => step.id === 'identity').env.COMPILER_POLICY_HASH.matchAll(/'([^']+)'/g)
  ].map((match) => match[1])
  for (const input of inputs) {
    expect(
      warmer.on.push.paths.some(
        (pattern) =>
          pattern === input ||
          (pattern.endsWith('/**') && input.startsWith(pattern.slice(0, -2))) ||
          (pattern.endsWith('*') && input.startsWith(pattern.slice(0, -1)))
      ),
      input
    ).toBe(true)
  }
})
