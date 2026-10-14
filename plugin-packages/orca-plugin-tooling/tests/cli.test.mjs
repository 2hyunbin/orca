import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { fixture, root, json } from './plugin-fixture.mjs'
import { createPluginLocaleKit } from '../dist/runtime.mjs'

const execute = promisify(execFile)
async function cli(args, path = join(root, 'src/cli.mjs')) {
  const result = await execute(process.execPath, [path, ...args], {
    windowsHide: true,
    timeout: 10_000
  })
  return JSON.parse(result.stdout)
}

test('init creates four independent templates with pinned validation and no installed dependencies', async (t) => {
  const { scratch } = await fixture(t)
  for (const type of ['locale', 'syntax', 'viewer', 'environment']) {
    const destination = join(scratch, `${type} with spaces`)
    const initialized = await cli([
      'init',
      type,
      destination,
      '--publisher',
      'author',
      '--id',
      `${type}-example`
    ])
    assert.equal(initialized.id, `author.${type}-example`)
    const localCli = join(destination, '.orca-tooling/src/cli.mjs')
    const validated = await cli(['validate', destination], localCli)
    assert.equal(validated.valid, true)
    assert.equal(
      validated.execution,
      type === 'viewer' ? 'sandboxed-ui' : type === 'environment' ? 'instructional' : 'data'
    )
    assert.equal(await readFile(join(destination, '.gitignore'), 'utf8'), 'node_modules/\n')
    await assert.rejects(stat(join(destination, 'node_modules')), { code: 'ENOENT' })
    assert.match(
      await readFile(join(destination, '.github/workflows/validate.yml'), 'utf8'),
      /persist-credentials: false/
    )
  }
})

test('init never overwrites a directory and removes only its own failed output', async (t) => {
  const { scratch, repo } = await fixture(t)
  await assert.rejects(cli(['init', 'locale', repo, '--publisher', 'author', '--id', 'example']))
  assert.ok(await readFile(join(repo, 'LICENSE')))
  const bad = join(scratch, 'bad')
  await assert.rejects(
    cli(['init', 'locale', bad, '--publisher', 'Invalid Author', '--id', 'example'])
  )
  await assert.rejects(stat(bad), { code: 'ENOENT' })
})

test('locale export/diff detects changed source and preserves existing output', async (t) => {
  const { scratch } = await fixture(t)
  const oldSource = join(scratch, 'old-source.json'),
    source = join(scratch, 'source.json')
  const oldKit = join(scratch, 'old-kit.json'),
    newKit = join(scratch, 'new-kit.json')
  await json(oldSource, { greeting: 'Hello {{name}}', removed: 'Old' })
  await json(source, { greeting: 'Welcome {{name}}', added: 'New' })
  await cli(['locale', 'export', oldSource, oldKit])
  const exported = await cli(['locale', 'export', source, newKit])
  assert.equal(exported.entries, 2)
  assert.deepEqual(await cli(['locale', 'diff', oldKit, newKit]), {
    added: ['added'],
    changed: ['greeting'],
    removed: ['removed']
  })
  await assert.rejects(cli(['locale', 'export', oldSource, newKit]))
  assert.equal(
    JSON.parse(await readFile(newKit, 'utf8')).sourceRevision,
    createPluginLocaleKit({ greeting: 'Welcome {{name}}', added: 'New' }).sourceRevision
  )
})

test('malformed options/commands exit nonzero rather than ignoring arguments', async (t) => {
  const { repo } = await fixture(t)
  for (const args of [
    ['unknown'],
    ['validate', repo, '--unknown', 'yes'],
    ['validate', repo, '--kit'],
    ['validate', repo, '--kit', 'one', '--kit', 'two'],
    ['inspect', repo, 'extra']
  ]) {
    await assert.rejects(
      cli(args),
      (error) => error.code === 1 && error.stderr.startsWith('orca-plugin:')
    )
  }
})
