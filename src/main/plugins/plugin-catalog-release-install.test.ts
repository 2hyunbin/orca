import {
  createCatalogReleaseFixture,
  setCatalogReleaseCommit
} from './plugin-catalog-release-test-fixture'
import { describe, expect, it } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPluginLocaleEnvelope } from '../../shared/plugins/plugin-locale-envelope'
import { getPluginLocaleKit } from './plugin-locale-source'
import { readPluginCurrentPointer } from './plugin-current-pointer'
import { readPluginLockfile } from './plugin-install'
import { installStagedPluginTree } from './plugin-install-staging'

describe('catalog checks at preview and publication', () => {
  it('installs checked bytes and records their provenance', async () => {
    const { root, installer, source, release, marketplace } = await createCatalogReleaseFixture()
    expect((await marketplace.listPlugins())[0]).toMatchObject({ name: 'German', release })
    const preview = await installer.preview(source.id, 'community.locale-de')
    expect(await installer.install(preview)).toMatchObject({
      ok: true,
      contentHash: release.contentHash
    })
    expect(
      (await readPluginLockfile(join(root, 'plugins'))).plugins['community.locale-de']
    ).toMatchObject({
      contentHash: release.contentHash,
      resolvedCommit: release.commit
    })
  })
  it('fails preview when a release tag moves and publishes nothing', async () => {
    const { root, installer, source } = await createCatalogReleaseFixture()
    setCatalogReleaseCommit('c'.repeat(40))
    await expect(installer.preview(source.id, 'community.locale-de')).rejects.toThrow(
      'catalog commit'
    )
    expect((await readPluginLockfile(join(root, 'plugins'))).plugins).toEqual({})
  })
  it('checks hashes again at publication and leaves the previous pointer intact', async () => {
    const { root, pack, release } = await createCatalogReleaseFixture()
    const pluginsDir = join(root, 'plugins')
    const source = {
      kind: 'git' as const,
      url: 'https://example.com/community/de.git',
      ref: 'v1.0.0'
    }
    expect(
      await installStagedPluginTree({
        pluginsDir,
        stagingDir: pack,
        hostVersion: '1.0.0',
        source,
        resolvedCommit: release.commit,
        expectedRelease: release
      })
    ).toMatchObject({ ok: true })
    await writeFile(
      join(pack, 'de.json'),
      JSON.stringify(
        createPluginLocaleEnvelope({
          kit: await getPluginLocaleKit(),
          locale: 'de',
          displayName: 'Deutsch',
          translations: { 'menu.file': 'CHANGED' }
        })
      )
    )
    expect(
      await installStagedPluginTree({
        pluginsDir,
        stagingDir: pack,
        hostVersion: '1.0.0',
        source,
        resolvedCommit: release.commit,
        expectedRelease: release
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining('release hash') })
    expect(await readPluginCurrentPointer(join(pluginsDir, 'community.locale-de'))).toBe(
      release.contentHash
    )
  })
})
