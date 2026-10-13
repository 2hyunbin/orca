import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pluginManifestSchema } from '../../../src/shared/plugins/plugin-manifest'
import type { createPluginCatalogFixture } from './plugin-catalog-fixture'
import { publishCatalogFixtureRelease } from './plugin-catalog-fixture-release'

export async function publishSyntaxFixtureUpdate(
  fixture: Awaited<ReturnType<typeof createPluginCatalogFixture>>
): Promise<void> {
  const directory = join(fixture.root, 'repositories', 'orca-syntax-sample.git')
  const manifestPath = join(directory, 'orca-plugin.json')
  const previous = pluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  await writeFile(manifestPath, JSON.stringify({ ...previous, version: '1.1.0' }))
  await writeFile(
    join(directory, 'grammar.json'),
    JSON.stringify({
      scopeName: 'source.sample',
      patterns: [
        { begin: '/\\*', end: '\\*/', name: 'comment.block.sample' },
        { match: '\\b(?:launch|updated)\\b', name: 'keyword.control.sample' },
        { match: '\\b[0-9]+\\b', name: 'constant.numeric.sample' },
        { begin: '"', end: '"', name: 'string.quoted.sample' }
      ]
    })
  )
  await publishCatalogFixtureRelease(fixture, 'orca-syntax-sample', '1.1.0')
}
