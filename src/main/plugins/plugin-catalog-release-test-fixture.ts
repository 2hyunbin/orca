import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import { createPluginLocaleEnvelope } from '../../shared/plugins/plugin-locale-envelope'
import { getPluginLocaleKit } from './plugin-locale-source'
import { pluginMarketplaceSchema } from '../../shared/plugins/plugin-marketplace'
import {
  pluginCatalogReleaseSchema,
  pluginCatalogTypes
} from '../../shared/plugins/plugin-catalog-release'
import { inspectPluginInstallTree } from './plugin-install-staging'
import { PluginMarketplaceService } from './plugin-marketplace-service'
import { PluginMarketplaceInstaller } from './plugin-marketplace-installer'

const catalogReleaseGit = vi.hoisted(() => ({ checkout: vi.fn(), commit: 'a'.repeat(40) }))
vi.mock('./plugin-git-repository', () => ({ checkoutPluginGitSource: catalogReleaseGit.checkout }))
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function writePack(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 2,
      execution: 'data',
      id: 'locale-de',
      publisher: 'community',
      name: 'German',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: { languagePacks: [{ locale: 'de', path: 'de.json' }] }
    })
  )
  await writeFile(
    join(root, 'de.json'),
    JSON.stringify(
      createPluginLocaleEnvelope({
        kit: await getPluginLocaleKit(),
        locale: 'de',
        displayName: 'Deutsch',
        translations: { 'menu.file': 'Datei' }
      })
    )
  )
}

export async function createCatalogReleaseFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-catalog-release-'))
  roots.push(root)
  const pack = join(root, 'pack')
  await writePack(pack)
  const inspection = await inspectPluginInstallTree({ rootDir: pack, hostVersion: '1.0.0' })
  if (!inspection.ok) {
    throw new Error(inspection.error)
  }
  const release = pluginCatalogReleaseSchema.parse({
    version: '1.0.0',
    commit: 'a'.repeat(40),
    contentHash: inspection.contentHash,
    execution: 'data',
    minimumOrca: '1.0.0',
    types: ['interface-language'],
    license: 'MIT'
  })
  let owner = 'community'
  const marketplace = new PluginMarketplaceService({
    pluginsDataDir: join(root, 'plugins-data'),
    fetcher: async () => ({
      marketplaceCommit: 'f'.repeat(40),
      marketplace: pluginMarketplaceSchema.parse({
        formatVersion: 2,
        name: 'Community',
        owner,
        plugins: [
          {
            id: 'community.locale-de',
            name: 'German',
            source: { kind: 'git', url: 'https://example.com/community/de.git', ref: 'v1.0.0' },
            release
          }
        ]
      })
    })
  })
  const source = await marketplace.addSource({
    kind: 'git',
    url: 'https://example.com/community/catalog.git',
    ref: 'main'
  })
  catalogReleaseGit.commit = release.commit
  let packWriter = writePack
  catalogReleaseGit.checkout.mockImplementation(
    async ({ destination }: { destination: string }) => {
      await packWriter(destination)
      return catalogReleaseGit.commit
    }
  )
  const installer = new PluginMarketplaceInstaller({
    marketplace,
    userDataPath: root,
    hostVersion: '1.0.0'
  })
  return {
    root,
    pack,
    release,
    marketplace,
    installer,
    source,
    publishPack: async (writer: typeof writePack) => {
      packWriter = writer
      await rm(pack, { recursive: true, force: true })
      await writer(pack)
      const candidate = await inspectPluginInstallTree({ rootDir: pack, hostVersion: '1.0.0' })
      if (!candidate.ok || candidate.manifest.manifestVersion !== 2) {
        throw new Error(candidate.ok ? 'expected a v2 release' : candidate.error)
      }
      release.version = candidate.manifest.version
      release.contentHash = candidate.contentHash
      release.execution = candidate.manifest.execution
      release.types = pluginCatalogTypes(candidate.manifest)
      release.commit = 'b'.repeat(40)
      catalogReleaseGit.commit = release.commit
      await marketplace.refreshSource(source.id)
    },
    setOwner: (value: string) => {
      owner = value
    }
  }
}

export function setCatalogReleaseCommit(value: string): void {
  catalogReleaseGit.commit = value
}
