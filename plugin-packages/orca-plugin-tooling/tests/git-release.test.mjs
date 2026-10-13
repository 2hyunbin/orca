import assert from 'node:assert/strict'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { hashPluginTree } from '../dist/runtime.mjs'
import { packRelease, git } from '../src/git-release.mjs'
import { exportCatalogRelease, diffCatalogFiles } from '../src/catalog-release.mjs'
import { commitFixture, fixture, json } from './plugin-fixture.mjs'

test('pack reproduces host tree hash, omits untracked files and never executes scripts', async (t) => {
  const { scratch, repo } = await fixture(t)
  await json(join(repo, 'package.json'), { scripts: { postinstall: 'exit 97' } })
  const commit = await commitFixture(repo)
  await writeFile(join(repo, 'untracked.txt'), 'excluded')
  const output = join(scratch, 'release')
  const packed = await packRelease(repo, output)
  assert.equal(packed.commit, commit)
  const expected = await hashPluginTree(output)
  assert.equal(expected.ok && expected.hash, packed.contentHash)
  await assert.rejects(readFile(join(output, 'untracked.txt')), { code: 'ENOENT' })
  assert.equal(
    await readFile(join(output, 'package.json'), 'utf8'),
    await readFile(join(repo, 'package.json'), 'utf8')
  )
})

test('changed tracked files fail and incomplete output is removed', async (t) => {
  const { scratch, repo } = await fixture(t)
  await commitFixture(repo)
  await writeFile(join(repo, 'language-configuration.json'), '{}')
  const output = join(scratch, 'release')
  await assert.rejects(packRelease(repo, output), /differs from commit/)
  await assert.rejects(readFile(join(output, 'orca-plugin.json')), { code: 'ENOENT' })
})

test('uncommitted viewer output cannot become a catalog release', async (t) => {
  const { scratch, repo } = await fixture(t, 'viewer')
  await commitFixture(repo)
  await git(repo, ['rm', '--cached', 'dist/example.worker.js'])
  await commitFixture(repo, false)
  await assert.rejects(packRelease(repo, join(scratch, 'release')), /ENOENT/)
})

test('existing destination and inside-repository destinations are preserved/rejected', async (t) => {
  const { scratch, repo } = await fixture(t)
  await commitFixture(repo)
  await assert.rejects(packRelease(repo, join(repo, 'output')), /outside/)
  await assert.rejects(packRelease(repo, repo), /outside/)
  await assert.rejects(packRelease(repo, scratch), { code: 'EEXIST' })
  assert.ok(await readFile(join(repo, 'orca-plugin.json')))
})

test(
  'tracked symlinks and parent aliases into the source cannot be packaged',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { scratch, repo } = await fixture(t)
    await symlink('language-configuration.json', join(repo, 'linked.json'))
    await commitFixture(repo)
    await assert.rejects(packRelease(repo, join(scratch, 'release')), /symlinks/)
    await symlink(repo, join(scratch, 'alias'), 'dir')
    await assert.rejects(packRelease(repo, join(scratch, 'alias', 'output')), /outside/)
  }
)

test('catalog export derives verified local tag, exact bytes and contribution class', async (t) => {
  const { repo } = await fixture(t)
  const commit = await commitFixture(repo)
  await git(repo, ['tag', 'v1.0.0'])
  const entry = await exportCatalogRelease(repo, {
    source: 'https://gitlab.example.org/author/syntax.git',
    ref: 'v1.0.0',
    license: 'MIT'
  })
  assert.equal(entry.release.commit, commit)
  assert.equal(entry.release.execution, 'data')
  assert.deepEqual(entry.release.types, ['coding-language'])
  assert.match(entry.release.contentHash, /^[0-9a-f]{64}$/)
  await assert.rejects(
    exportCatalogRelease(repo, { source: entry.source.url, ref: 'v2.0.0', license: 'MIT' })
  )
  await assert.rejects(
    exportCatalogRelease(repo, { source: 'file:///tmp/repo', ref: 'v1.0.0', license: 'MIT' })
  )
})

test('catalog diff separates changed metadata and never grants approval', async (t) => {
  const { scratch, repo } = await fixture(t)
  await commitFixture(repo)
  await git(repo, ['tag', 'v1.0.0'])
  const entry = await exportCatalogRelease(repo, {
    source: 'https://example.org/author/syntax.git',
    ref: 'v1.0.0',
    license: 'MIT'
  })
  const previous = { formatVersion: 2, name: 'Plugins', owner: 'author', plugins: [entry] }
  const current = structuredClone(previous)
  current.owner = 'other'
  current.plugins[0].release.execution = 'sandboxed-ui'
  current.plugins[0].source.url = 'https://example.org/other/syntax.git'
  const before = join(scratch, 'before.json'),
    after = join(scratch, 'after.json')
  await json(before, previous)
  await json(after, current)
  const diff = await diffCatalogFiles(before, after)
  assert.equal(diff.ownerChanged, true)
  assert.equal(diff.changed[0].sourceChanged, true)
  assert.equal(diff.changed[0].executionChanged, true)
  assert.match(diff.changed[0].note, /does not approve/)
})
