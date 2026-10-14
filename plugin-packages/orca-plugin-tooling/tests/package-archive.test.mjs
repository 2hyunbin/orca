import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { commitFixture, root } from './plugin-fixture.mjs'
import { git } from '../src/git-release.mjs'

const execute = promisify(execFile)
test('packed tarball initializes and releases all templates with Windows-style Git settings', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-tooling-archive-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  assert.ok(process.env.npm_execpath, 'Run the package suite with npm test')
  const run = async (args) =>
    execute(process.execPath, args, { cwd: root, windowsHide: true, timeout: 30_000 })
  const packed = await run([
    process.env.npm_execpath,
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    scratch
  ])
  const archive = JSON.parse(packed.stdout)[0]
  assert.equal(archive.id, '@orca/plugin-tooling@1.0.0')
  await run([
    process.env.npm_execpath,
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix',
    join(scratch, 'installed'),
    join(scratch, archive.filename)
  ])
  const cli = join(scratch, 'installed/node_modules/@orca/plugin-tooling/src/cli.mjs')
  for (const type of ['locale', 'syntax', 'viewer', 'environment']) {
    const destination = join(scratch, type)
    await run([cli, 'init', type, destination, '--publisher', 'author', '--id', `${type}-archive`])
    const result = await run([
      join(destination, '.orca-tooling/src/cli.mjs'),
      'validate',
      destination
    ])
    assert.equal(JSON.parse(result.stdout).valid, true)
    assert.ok(await stat(join(destination, '.github/workflows/validate.yml')))
    if (type === 'environment') {
      await run(['--test', join(destination, 'tests/provider-client.test.mjs')])
    }
    await assert.rejects(stat(join(destination, 'node_modules')), { code: 'ENOENT' })
    assert.equal(await readFile(join(destination, '.gitattributes'), 'utf8'), '* -text\n')
    await commitFixture(destination)
    const checkout = join(scratch, `${type}-crlf-checkout`)
    await git(destination, [
      '-c',
      'core.autocrlf=true',
      '-c',
      `core.hooksPath=${join(destination, '.git', 'fixture-empty-hooks')}`,
      'clone',
      '--quiet',
      '--template=',
      '--',
      destination,
      checkout
    ])
    const release = join(scratch, `${type}-release`)
    const packedRelease = JSON.parse((await run([cli, 'pack', checkout, release])).stdout)
    const inspected = JSON.parse((await run([cli, 'inspect', destination])).stdout)
    assert.equal(packedRelease.contentHash, inspected.contentHash)
    assert.equal(
      await readFile(join(checkout, 'orca-plugin.json'), 'utf8'),
      await readFile(join(destination, 'orca-plugin.json'), 'utf8')
    )
  }
  const nested = join(scratch, 'from-vendored-tooling')
  await run([
    join(scratch, 'locale/.orca-tooling/src/cli.mjs'),
    'init',
    'syntax',
    nested,
    '--publisher',
    'author',
    '--id',
    'syntax-vendored'
  ])
  assert.equal(
    JSON.parse((await run([join(nested, '.orca-tooling/src/cli.mjs'), 'validate', nested])).stdout)
      .valid,
    true
  )
})
