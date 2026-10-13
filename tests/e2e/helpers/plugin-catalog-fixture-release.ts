import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hashPluginTree } from '../../../src/main/plugins/plugin-content-hash'
import { pluginMarketplaceSchema } from '../../../src/shared/plugins/plugin-marketplace'
import type { createPluginCatalogFixture } from './plugin-catalog-fixture'

export async function publishCatalogFixtureRelease(
  fixture: Awaited<ReturnType<typeof createPluginCatalogFixture>>,
  repository: string,
  version: string
): Promise<void> {
  const directory = join(fixture.root, 'repositories', `${repository}.git`)
  await fixture.runGit(directory, ['add', '--all'])
  await fixture.runGit(directory, [
    '-c',
    'user.name=Orca Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'plugin fixture update'
  ])
  await fixture.runGit(directory, ['tag', `v${version}`])
  const commit = await fixture.runGit(directory, ['rev-parse', 'HEAD'])
  const hash = await hashPluginTree(directory)
  if (!hash.ok) {
    throw new Error(hash.error)
  }
  const catalogDirectory = join(fixture.root, 'repositories', 'orca-plugins.git')
  const catalogPath = join(catalogDirectory, 'orca-marketplace.json')
  const catalog = pluginMarketplaceSchema.parse(JSON.parse(await readFile(catalogPath, 'utf8')))
  if (!('formatVersion' in catalog) || catalog.formatVersion !== 2) {
    throw new Error('fixture requires a pinned catalog')
  }
  const listing = catalog.plugins.find((item) => item.id === `stablyai.${repository}`)
  if (!listing) {
    throw new Error('fixture listing missing')
  }
  listing.source.ref = `v${version}`
  listing.release = { ...listing.release, version, commit, contentHash: hash.hash }
  await writeFile(catalogPath, JSON.stringify(catalog))
  await fixture.runGit(catalogDirectory, ['add', '--all'])
  await fixture.runGit(catalogDirectory, [
    '-c',
    'user.name=Orca Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'catalog fixture update'
  ])
}
