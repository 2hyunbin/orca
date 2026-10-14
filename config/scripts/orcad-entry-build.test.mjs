import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  buildOrcadEntry,
  externalNativeAddons,
  ORCAD_COMMONJS_MODULE_OPTIONS,
  ORCAD_EXTERNAL_MODULES,
  ORCAD_PLUGIN_HOST_VERSION_DEFINE
} from './orcad-entry-build.mjs'
import { runProcessSync } from '@orca/process-host'

const directory = mkdtempSync(join(tmpdir(), 'orca-structured-provider-build-'))
const bundle = join(directory, 'orcad-server.js')

beforeAll(async () => {
  const built = await buildOrcadEntry(bundle)
  const electronImports = Object.entries(built.metafile.inputs)
    .filter(([, input]) => input.imports.some((entry) => entry.path === 'electron'))
    .map(([path]) => path)
  expect(electronImports).toEqual([])
}, 60_000)

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

it('loads the shared SSH connection and retirement paths under plain Node without Electron', async () => {
  const outdir = join(directory, 'ssh-host')
  const built = await build({
    ...ORCAD_COMMONJS_MODULE_OPTIONS,
    entryPoints: {
      connect: resolve('src/main/ipc/ssh-connect-flow.ts'),
      retire: resolve('src/main/ipc/environment-provider-ssh-retirement.ts')
    },
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outdir,
    external: ORCAD_EXTERNAL_MODULES,
    plugins: [externalNativeAddons],
    metafile: true,
    logLevel: 'error'
  })
  const electronImports = Object.entries(built.metafile.inputs)
    .filter(([, input]) => input.imports.some((entry) => entry.path === 'electron'))
    .map(([path]) => path)
  expect(electronImports).toEqual([])
  const loaded = runProcessSync({
    program: process.execPath,
    args: [
      '-e',
      `const assert=require('node:assert/strict');
       assert.equal(typeof require(${JSON.stringify(join(outdir, 'connect.js'))}).connectTarget,'function');
       assert.equal(typeof require(${JSON.stringify(join(outdir, 'retire.js'))}).retireEnvironmentProviderSshTarget,'function');`
    ],
    cwd: directory,
    env: { ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 5000
  })
  expect(loaded.code, loaded.stderr).toBe(0)
})

it('checks plugin engines against the compiled Orca app version rather than the deployed artifact identity', async () => {
  const outfile = join(directory, 'plugin-host-version.cjs')
  await build({
    entryPoints: [resolve('src/main/orcad/orcad-plugin-host-version.ts')],
    platform: 'node',
    format: 'cjs',
    bundle: true,
    outfile,
    define: ORCAD_PLUGIN_HOST_VERSION_DEFINE,
    logLevel: 'error'
  })
  const loaded = runProcessSync({
    program: process.execPath,
    args: [
      '-e',
      `process.stdout.write(require(${JSON.stringify(outfile)}).orcadPluginHostVersion())`
    ],
    cwd: directory,
    env: {
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_VERSION: '0.2.0+artifact-hash',
      ORCA_PLUGIN_HOST_VERSION: '0.0.0-untrusted-launch-value'
    },
    timeoutMs: 5000
  })
  expect(loaded.code, loaded.stderr).toBe(0)
  expect(loaded.stdout).toBe(JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version)
})

it('loads the structured Claude SDK through the packaged server under plain Node', () => {
  const loaded = runProcessSync({
    program: process.execPath,
    args: [bundle, '--orcad-structured-provider-load-check'],
    cwd: directory,
    env: { ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 30_000
  })
  expect(loaded.code, loaded.stderr.slice(-2_000)).toBe(0)
}, 40_000)

it('resolves bundle-relative requires after deployment to a path with URL-special characters', async () => {
  const buildDirectory = join(directory, 'build')
  mkdirSync(buildDirectory)
  const outfile = join(buildDirectory, 'entry.cjs')
  await build({
    ...ORCAD_COMMONJS_MODULE_OPTIONS,
    stdin: {
      contents: `import { createRequire } from 'node:module';
        console.log(createRequire(import.meta.url)('./asset.cjs'));`,
      resolveDir: directory
    },
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile,
    minify: true,
    logLevel: 'error'
  })
  writeFileSync(join(buildDirectory, 'asset.cjs'), 'module.exports = "deployed asset"')
  const deployedDirectory = join(directory, 'deployed # 100%')
  renameSync(buildDirectory, deployedDirectory)
  const loaded = runProcessSync({
    program: process.execPath,
    args: [join(deployedDirectory, 'entry.cjs')],
    cwd: directory,
    env: { ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 30_000
  })
  expect(loaded.code, loaded.stderr).toBe(0)
  expect(loaded.stdout.trim()).toBe('deployed asset')
})

it.each(['import.meta', 'import.meta.dirname', 'import.meta.filename', 'import.meta.resolve'])(
  'rejects unsupported %s instead of silently replacing it with an empty object',
  async (expression) => {
    await expect(
      build({
        ...ORCAD_COMMONJS_MODULE_OPTIONS,
        stdin: { contents: `console.log(${expression})`, resolveDir: directory },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        write: false,
        logLevel: 'silent'
      })
    ).rejects.toThrow('"import.meta" is not available')
  }
)
