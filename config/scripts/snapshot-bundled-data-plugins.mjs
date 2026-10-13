import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '../..')
const launch = join(root, 'resources', 'plugins', 'launch')
const check = process.argv.includes('--check')
if (process.argv.slice(2).some((argument) => argument !== '--check')) {
  throw new Error('Only --check is supported')
}
const built = await build({
  entryPoints: [join(root, 'config', 'scripts', 'bundled-data-plugin-runtime.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'node22'
})
try {
  const runtime = await import(
    `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`
  )
  async function output(path, bytes) {
    if (check) {
      if (!(await readFile(path)).equals(Buffer.from(bytes))) {
        throw new Error(`Bundled data snapshot drift: ${path}`)
      }
    } else {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, bytes)
    }
  }
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`
  const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
  const readReleaseText = async (path) => (await readFile(path, 'utf8')).replaceAll('\r\n', '\n')
  const english = await readJson(join(root, 'src', 'renderer', 'src', 'i18n', 'locales', 'en.json'))
  const spanish = await readJson(join(root, 'src', 'renderer', 'src', 'i18n', 'locales', 'es.json'))
  const kit = runtime.createPluginLocaleKit(english)
  const translated = {}
  function flatten(value, prefix = '') {
    for (const [key, item] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (typeof item === 'string') {
        translated[path] = item
      } else if (item && typeof item === 'object' && !Array.isArray(item)) {
        flatten(item, path)
      }
    }
  }
  flatten(spanish)
  const security = {}
  for (const [path, value] of Object.entries(translated)) {
    if (!runtime.isProtectedPluginTranslationPath(path)) {
      continue
    }
    const parts = path.split('.')
    let parent = security
    for (const part of parts.slice(0, -1)) {
      parent = parent[part] ??= {}
    }
    parent[parts.at(-1)] = value
  }
  await output(
    join(root, 'src', 'renderer', 'src', 'i18n', 'locales', 'es-plugin-security.json'),
    json(security)
  )
  const translations = {}
  for (const [path, source] of Object.entries(kit.entries)) {
    const value = translated[path]
    if (
      typeof value === 'string' &&
      value.length <= 8192 &&
      JSON.stringify(runtime.pluginTranslationPlaceholders(source.value)) ===
        JSON.stringify(runtime.pluginTranslationPlaceholders(value))
    ) {
      translations[path] = value
    }
  }
  const localeId = 'stablyai.orca-locale-es'
  const syntaxId = 'stablyai.orca-syntax-typst'
  let envelope
  try {
    // Existing source hashes require translator review; builds never refresh them.
    envelope = await readJson(join(launch, localeId, 'locales', 'es.json'))
  } catch (error) {
    if (error?.code !== 'ENOENT' || check) {
      throw error
    }
    envelope = runtime.createPluginLocaleEnvelope({
      kit,
      locale: 'es',
      displayName: 'Español',
      translations
    })
  }
  const locale = runtime.parsePluginLocaleEnvelope(json(envelope), 'es', kit)
  const base = (id, name, description) => ({
    manifestVersion: 2,
    execution: 'data',
    id: id.slice('stablyai.'.length),
    publisher: 'stablyai',
    name,
    description,
    version: '1.0.0',
    engines: { orca: '>=1.4.214' },
    pluginApi: 1,
    capabilities: []
  })
  const localeManifest = {
    ...base(localeId, 'Spanish', 'Spanish interface translations included with Orca.'),
    contributes: { languagePacks: [{ locale: 'es', path: 'locales/es.json' }] }
  }
  const syntaxManifest = {
    ...base(syntaxId, 'Typst syntax', 'Typst syntax data included with Orca.'),
    contributes: {
      languages: [
        {
          id: 'typst',
          aliases: ['Typst', 'typst'],
          extensions: ['.typ'],
          filenames: [],
          configuration: 'language-configuration.json'
        }
      ],
      grammars: [
        { language: 'typst', scopeName: 'source.typst', path: 'syntaxes/typst.tmLanguage.json' }
      ]
    }
  }
  const configuration = {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')']
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' }
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' }
    ]
  }
  for (const [pluginKey, manifest] of [
    [localeId, localeManifest],
    [syntaxId, syntaxManifest]
  ]) {
    const parsed = runtime.parsePluginManifest(manifest)
    if (!parsed.ok) {
      throw new Error(parsed.error)
    }
    await output(join(launch, pluginKey, 'orca-plugin.json'), json(manifest))
    await output(join(launch, pluginKey, 'LICENSE'), await readReleaseText(join(root, 'LICENSE')))
    await output(
      join(launch, pluginKey, 'README.md'),
      `# ${manifest.name}\n\nApp-owned data snapshot generated by snapshot-bundled-data-plugins.mjs.\nThe bundle index pins the full tree; optional installations never overwrite these files.\n`
    )
  }
  await output(join(launch, localeId, 'locales', 'es.json'), json(envelope))
  await output(join(launch, syntaxId, 'language-configuration.json'), json(configuration))
  const grammarRoot = join(
    root,
    'src',
    'renderer',
    'src',
    'lib',
    'monaco-languages',
    'textmate-grammars'
  )
  await output(
    join(launch, syntaxId, 'syntaxes', 'typst.tmLanguage.json'),
    await readReleaseText(join(grammarRoot, 'typst.tmLanguage.json'))
  )
  await output(
    join(launch, syntaxId, 'THIRD-PARTY-LICENSES.txt'),
    await readReleaseText(join(grammarRoot, 'typst-LICENSE.txt'))
  )
  await runtime.readPluginSyntaxContent(
    runtime.parsePluginManifest(syntaxManifest).manifest,
    async (path) => readFile(join(launch, syntaxId, ...path.split('/')), 'utf8')
  )
  const indexPath = join(launch, 'bundled-plugins.json')
  const index = await readJson(indexPath)
  for (const pluginKey of [localeId, syntaxId]) {
    const hashed = await runtime.hashPluginTree(join(launch, pluginKey))
    if (!hashed.ok) {
      throw new Error(hashed.error)
    }
    const entry = {
      pluginKey,
      path: pluginKey,
      contentHash: hashed.hash,
      activation: 'bundled-data'
    }
    const previous = index.plugins.findIndex((item) => item.pluginKey === pluginKey)
    if (previous === -1) {
      index.plugins.push(entry)
    } else {
      index.plugins[previous] = entry
    }
  }
  await output(indexPath, json(index))
  console.log(
    `Bundled Spanish/Typst data ${check ? 'verified' : 'generated'}: ${locale.coverage.current} current / ${locale.coverage.stale} stale translations.`
  )
} catch (error) {
  console.error(error instanceof Error ? error.message.slice(0, 2000) : String(error))
  process.exitCode = 1
}
