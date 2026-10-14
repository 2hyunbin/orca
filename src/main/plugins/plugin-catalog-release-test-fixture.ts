import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcess } from '@orca/process-host'
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

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function commitPack(pack: string, tag: string): Promise<string> {
  const git = async (args: string[]): Promise<string> => {
    const result = await runProcess({ program: 'git', args, cwd: pack, timeoutMs: 30_000 })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error(result.stderr || 'Catalog fixture Git failed')
    }
    return result.stdout.trim()
  }
  await git(['init', '--quiet', '--template='])
  await git(['add', '.'])
  await git([
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Plugin fixture',
    '-c',
    'user.email=plugins@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'catalog fixture'
  ])
  await git(['tag', '--force', tag])
  return git(['rev-parse', 'HEAD'])
}

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
  const gitConfig = join(root, 'git-config')
  await writeFile(
    gitConfig,
    `[url "${pathToFileURL(pack).href}"]\n\tinsteadOf = https://example.com/community/de.git\n`
  )
  vi.stubEnv('GIT_CONFIG_GLOBAL', gitConfig)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  vi.stubEnv('GIT_DEFAULT_HASH', 'sha1')
  await writePack(pack)
  let releaseRef = 'v1.0.0'
  const commit = await commitPack(pack, releaseRef)
  const inspection = await inspectPluginInstallTree({ rootDir: pack, hostVersion: '1.0.0' })
  if (!inspection.ok) {
    throw new Error(inspection.error)
  }
  const release = pluginCatalogReleaseSchema.parse({
    version: '1.0.0',
    commit,
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
            source: {
              kind: 'git',
              url: 'https://example.com/community/de.git',
              ref: releaseRef
            },
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
      releaseRef = `v${release.version}`
      release.commit = await commitPack(pack, releaseRef)
      await marketplace.refreshSource(source.id)
    },
    setOwner: (value: string) => {
      owner = value
    },
    moveReleaseTag: async () => {
      await writeFile(join(pack, 'moved-tag.txt'), 'This tag moved after publication.\n')
      await commitPack(pack, releaseRef)
    }
  }
}
