import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pluginManifestSchema } from '../../../src/shared/plugins/plugin-manifest'
import type { createPluginCatalogFixture } from './plugin-catalog-fixture'
import { publishCatalogFixtureRelease } from './plugin-catalog-fixture-release'

export async function publishViewerFixtureUpdate(
  fixture: Awaited<ReturnType<typeof createPluginCatalogFixture>>
): Promise<void> {
  const directory = join(fixture.root, 'repositories', 'orca-viewer-sample.git')
  const manifestPath = join(directory, 'orca-plugin.json')
  const previous = pluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  await writeFile(manifestPath, JSON.stringify({ ...previous, version: '1.1.0' }))
  await writeFile(
    join(directory, 'dist', 'sample.worker.js'),
    `let lines;
orcaViewer.register({
  async open(document) {
    const bytes = await orcaViewer.readBytes(0, Math.max(1, document.size));
    lines = ['Updated viewer', ...new TextDecoder().decode(bytes).split('\\n')];
    return {kind:'text',lineCount:lines.length};
  },
  render(viewport) {
    return {kind:'text',startLine:viewport.startLine,lines:lines.slice(viewport.startLine,viewport.startLine+viewport.lineCount)};
  }
});`
  )
  await publishCatalogFixtureRelease(fixture, 'orca-viewer-sample', '1.1.0')
}
