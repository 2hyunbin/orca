import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { git } from '../src/git-release.mjs'

export const root = fileURLToPath(new URL('../', import.meta.url))

export async function fixture(t, type = 'syntax') {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-tooling-test-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const repo = join(scratch, 'repo')
  await cp(join(root, 'templates', type), repo, {
    recursive: true,
    filter: (path) => !path.split(/[\\/]/).includes('node_modules')
  })
  return { scratch, repo }
}

export async function commitFixture(repo, add = true) {
  await git(repo, ['init'])
  if (add) {
    await git(repo, ['add', '.'])
  }
  const hooks = join(repo, '.git', 'fixture-empty-hooks')
  await mkdir(hooks, { recursive: true })
  await git(repo, [
    '-c',
    'user.name=Plugin Fixture',
    '-c',
    'user.email=plugin-fixture@example.invalid',
    '-c',
    `core.hooksPath=${hooks}`,
    'commit',
    '--no-gpg-sign',
    '-m',
    'Fixture release'
  ])
  return (await git(repo, ['rev-parse', 'HEAD'])).trim()
}

export async function json(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}
