import type { EnvironmentRecipeResource } from '../../../src/shared/environment-recipe-protocol'
import { writePluginPortuguesePackageEnvelope } from './plugin-portuguese-package-fixture'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcess } from '@orca/process-host'
import { hashPluginTree } from '../../../src/main/plugins/plugin-content-hash'
import {
  pluginMarketplaceSchema,
  type PluginMarketplaceEntry
} from '../../../src/shared/plugins/plugin-marketplace'
import {
  pluginCatalogReleaseSchema,
  pluginCatalogTypes
} from '../../../src/shared/plugins/plugin-catalog-release'
import { parsePluginManifest } from '../../../src/shared/plugins/plugin-manifest'

import { writePluginSyntaxFixture } from './plugin-syntax-package-fixture'
import { writePluginViewerFixture } from './plugin-viewer-package-fixture'
import { writePluginHostileViewerFixture } from './plugin-hostile-viewer-fixture'
import { writePluginAuthorTemplateFixture } from './plugin-author-template-fixture'
import { writePluginEnvironmentPackageFixture } from './plugin-environment-package-fixture'

type CatalogSample = {
  directory?: string
  repo: string
  title: string
  preview: string
  syntax?: 'typst' | 'sample'
  viewer?: boolean
  formatViewer?: 'xlsx' | 'stl'
  template?: 'locale' | 'syntax' | 'viewer'
  environment?: boolean
}

export async function createPluginCatalogFixture(
  options: {
    syntaxPacks?: boolean
    syntaxConflict?: boolean
    viewerPack?: boolean
    viewerConflict?: boolean
    formatViewers?: boolean
    hostileViewers?: boolean
    generatedTemplates?: boolean
    environmentPortable?: boolean
    environmentRecipes?: boolean
    environmentConnection?: EnvironmentRecipeResource['connection']
    environmentRecovery?: { interruptCreate: boolean }
    gitObjectFormat?: 'sha1' | 'sha256'
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-phase-o-1-catalog-'))
  const home = join(root, 'home')
  const repositories = join(root, 'repositories')
  await mkdir(home, { recursive: true })
  await mkdir(repositories)
  const config = join(home, '.gitconfig')
  const gitEnvironment = {
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0'
  }
  const runGit = async (cwd: string, args: string[]): Promise<string> => {
    const result = await runProcess({
      program: 'git',
      args,
      cwd,
      env: {
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
        ),
        ...gitEnvironment
      }
    })
    if (result.code !== 0) {
      throw new Error(result.stderr || 'fixture git failed')
    }
    return result.stdout.trim()
  }
  for (const [key, value] of [
    [
      `url.${pathToFileURL(`${repositories}${sep}`).href}.insteadOf`,
      'https://github.com/stablyai/'
    ],
    ['protocol.file.allow', 'always'],
    ['commit.gpgSign', 'false'],
    ['tag.gpgSign', 'false'],
    ['core.hooksPath', join(home, 'no-hooks')]
  ]) {
    await runGit(home, ['config', '--file', config, key!, value!])
  }
  if (options.generatedTemplates) {
    await runGit(home, [
      'config',
      '--file',
      config,
      '--add',
      `url.${pathToFileURL(`${repositories}${sep}`).href}.insteadOf`,
      'https://gitlab.example.org/fixture-author/'
    ])
  }
  const commit = async (directory: string): Promise<string> => {
    await runGit(directory, [
      'init',
      '--quiet',
      ...(options.gitObjectFormat === 'sha256' ? ['--object-format=sha256'] : [])
    ])
    await runGit(directory, ['checkout', '--quiet', '-b', 'main'])
    await runGit(directory, ['add', '--all'])
    await runGit(directory, [
      '-c',
      'user.name=Orca Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture'
    ])
    await runGit(directory, ['tag', 'v1.0.0'])
    return runGit(directory, ['rev-parse', 'HEAD'])
  }
  const plugins: PluginMarketplaceEntry[] = []
  const samples: CatalogSample[] = [
    {
      directory: 'stablyai.orca-portuguese',
      repo: 'orca-portuguese',
      title: 'Portuguese (Brazil)',
      preview: 'Abrir arquivo · Configurações · Espaço de trabalho'
    },
    {
      directory: 'stablyai.orca-nord-theme',
      repo: 'orca-nord-theme',
      title: 'Nord appearance',
      preview: 'A quiet app theme, matching terminal palette and file icons.'
    }
  ]
  if (options.environmentRecipes) {
    samples.push({
      repo: 'orca-environments-devpods',
      title: 'Development environments',
      preview: 'Create · list · sleep · wake · archive · delete',
      environment: true
    })
  }
  if (options.syntaxPacks) {
    samples.push(
      {
        repo: 'orca-syntax-typst',
        title: 'Typst syntax',
        preview: '#let answer = 12pt',
        syntax: 'typst'
      },
      {
        repo: 'orca-syntax-sample',
        title: 'Sample syntax',
        preview: 'launch "example" 42',
        syntax: 'sample'
      }
    )
  }
  if (options.viewerPack) {
    samples.push({
      repo: 'orca-viewer-sample',
      title: 'Sample file viewer',
      preview: 'Read-only additional file format',
      viewer: true
    })
  }
  if (options.formatViewers) {
    samples.push(
      {
        repo: 'orca-viewer-xlsx',
        title: 'XLSX tables',
        preview: 'Worksheets, values, dates and cached results',
        viewer: true,
        formatViewer: 'xlsx'
      },
      {
        repo: 'orca-viewer-stl',
        title: 'STL models',
        preview: 'Binary models with orbit and zoom',
        viewer: true,
        formatViewer: 'stl'
      }
    )
  }
  if (options.generatedTemplates) {
    for (const template of ['locale', 'syntax', 'viewer'] as const) {
      samples.push({
        repo: `orca-template-${template}`,
        title: `${template} template`,
        preview: 'Generated independent author package',
        template,
        viewer: template === 'viewer'
      })
    }
  }
  for (const sample of samples) {
    const directory = join(repositories, `${sample.repo}.git`)
    if (sample.environment) {
      await writePluginEnvironmentPackageFixture(
        directory,
        join(root, 'provider-executed'),
        options.environmentConnection,
        options.environmentRecovery,
        options.environmentPortable
      )
    } else if (sample.template) {
      await writePluginAuthorTemplateFixture(directory, sample.template)
    } else if (sample.formatViewer) {
      const authoring = join(process.cwd(), 'plugin-packages', `orca-viewer-${sample.formatViewer}`)
      await mkdir(directory)
      for (const entry of ['orca-plugin.json', 'LICENSE', 'README.md', 'dist']) {
        await cp(join(authoring, entry), join(directory, entry), { recursive: true })
      }
      if (sample.formatViewer === 'xlsx') {
        await cp(
          join(authoring, 'THIRD-PARTY-LICENSES.txt'),
          join(directory, 'THIRD-PARTY-LICENSES.txt')
        )
      }
    } else if (sample.viewer) {
      await writePluginViewerFixture(directory, options.viewerConflict)
      if (options.hostileViewers) {
        await writePluginHostileViewerFixture(directory)
      }
    } else if (sample.syntax) {
      await writePluginSyntaxFixture(directory, sample.syntax, options.syntaxConflict)
    } else if (sample.directory) {
      await cp(join(process.cwd(), 'resources', 'plugins', 'launch', sample.directory), directory, {
        recursive: true
      })
    }
    const raw = JSON.parse(await readFile(join(directory, 'orca-plugin.json'), 'utf8'))
    const parsed = parsePluginManifest({
      ...raw,
      manifestVersion: 2,
      execution: sample.environment ? 'instructional' : sample.viewer ? 'sandboxed-ui' : 'data',
      name: sample.title
    })
    if (!parsed.ok) {
      throw new Error(parsed.error)
    }
    await writeFile(join(directory, 'orca-plugin.json'), JSON.stringify(parsed.manifest, null, 2))
    if (sample.repo === 'orca-portuguese') {
      await writePluginPortuguesePackageEnvelope(directory)
    }
    const resolvedCommit = await commit(directory)
    const hash = await hashPluginTree(directory)
    if (!hash.ok) {
      throw new Error(hash.error)
    }
    plugins.push({
      id: `${parsed.manifest.publisher}.${parsed.manifest.id}`,
      name: sample.title,
      categories: pluginCatalogTypes(parsed.manifest),
      description: parsed.manifest.description,
      source: {
        kind: 'git',
        url: sample.template
          ? `https://gitlab.example.org/fixture-author/${sample.repo}.git`
          : `https://github.com/stablyai/${sample.repo}.git`,
        ref: 'v1.0.0'
      },
      release: pluginCatalogReleaseSchema.parse({
        version: parsed.manifest.version,
        commit: resolvedCommit,
        contentHash: hash.hash,
        execution: sample.environment ? 'instructional' : sample.viewer ? 'sandboxed-ui' : 'data',
        minimumOrca: parsed.manifest.engines.orca.slice(2),
        license: 'MIT',
        types: pluginCatalogTypes(parsed.manifest),
        preview: { title: 'Package preview', text: sample.preview }
      })
    })
  }
  const catalogDir = join(repositories, 'orca-plugins.git')
  await mkdir(catalogDir)
  await writeFile(
    join(catalogDir, 'orca-marketplace.json'),
    JSON.stringify(
      pluginMarketplaceSchema.parse({
        formatVersion: 2,
        name: 'Orca Plugins',
        owner: 'stablyai',
        plugins
      }),
      null,
      2
    )
  )
  await commit(catalogDir)
  return { root, gitEnvironment, runGit }
}
