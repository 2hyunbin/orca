import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getLocale: () => 'es-ES' } }))

import {
  mainI18n,
  setMainPluginLanguagePacks,
  setMainUiLanguage,
  translateMain
} from '../../src/main/i18n/main-i18n'
import {
  getIntlLocale,
  i18n,
  setRendererPluginLanguagePacks,
  setRendererUiLanguage,
  translate
} from '../../src/renderer/src/i18n/i18n'
import { PluginService } from '../../src/main/plugins/plugin-service'
import { createPluginLocaleKit } from '../../src/shared/plugins/plugin-locale-kit'
import { parsePluginLocaleEnvelope } from '../../src/shared/plugins/plugin-locale-envelope'
import {
  pluginLanguageResourceId,
  isProtectedPluginTranslationPath
} from '../../src/shared/plugins/plugin-language-pack-artifact'
import { resolvePluginSyntaxLanguage } from '../../src/renderer/src/lib/monaco-languages/plugin-syntax-slot-pool'
import { pluginManifestSchema } from '../../src/shared/plugins/plugin-manifest'
import { pluginSyntaxPackMetadataSchema } from '../../src/shared/plugins/plugin-syntax-pack'
import english from '../../src/renderer/src/i18n/locales/en.json'
import security from '../../src/renderer/src/i18n/locales/es-plugin-security.json'

const root = join(process.cwd(), 'resources', 'plugins', 'launch')
let service: PluginService
let userDataPath: string
beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), 'orca-bundled-language-runtime-'))
  service = new PluginService({
    userDataPath,
    bundledPluginsRoot: root,
    hostVersion: '1.4.214',
    isPluginSystemEnabled: () => false,
    getDisabledPlugins: () => [],
    getPluginConsents: () => ({}),
    getDevPluginPaths: () => []
  })
  await service.initialize()
})
afterEach(async () => {
  setMainPluginLanguagePacks([])
  setRendererPluginLanguagePacks([])
  await setMainUiLanguage('en')
  await setRendererUiLanguage('en')
  await service.dispose()
  await rm(userDataPath, { recursive: true, force: true })
})

function applyPacks(packs = service.contentPacks.languagePacks.list()): void {
  const aliases = service.getBundledDataAliases()
  setMainPluginLanguagePacks(packs, aliases)
  setRendererPluginLanguagePacks(packs, aliases)
}

describe('bundled data through actual translation and syntax consumers', () => {
  it('maps saved and system Spanish to verified package resources in both processes', async () => {
    applyPacks()
    const pack = service.contentPacks.languagePacks.list()[0]!
    expect(pack.builtInLocale).toBe('es')
    expect(await setMainUiLanguage('es')).toBe(pack.resourceLanguage)
    await setRendererUiLanguage('es')
    expect(i18n.language).toBe(pack.resourceLanguage)
    expect(getIntlLocale()).toBe('es')
    expect(translateMain('menu.file', 'File')).toBe('Archivo')
    expect(translate('menu.file', 'File')).toBe('Archivo')
    expect(await setMainUiLanguage('system')).toBe(pack.resourceLanguage)
    const syntaxes = service.contentPacks.syntaxPacks.list()
    expect(resolvePluginSyntaxLanguage(syntaxes, '/folder/note.typ', 'typst')).toBe(
      'syntax:stablyai.orca-syntax-typst/typst'
    )
    expect(
      resolvePluginSyntaxLanguage(syntaxes, 'C:\\folder\\note.typ', 'typst', 'plaintext')
    ).toBeNull()
  })

  it('uses English for stale entries even after the old full Spanish catalog was loaded', async () => {
    await mainI18n.changeLanguage('es')
    await i18n.changeLanguage('es')
    const raw = await readFile(join(root, 'stablyai.orca-locale-es', 'locales', 'es.json'), 'utf8')
    const changedSource = structuredClone(english)
    changedSource.menu.file = 'Updated file menu'
    const parsed = parsePluginLocaleEnvelope(raw, 'es', createPluginLocaleKit(changedSource))
    expect(parsed.coverage.stale).toBeGreaterThan(0)
    const pack = service.contentPacks.languagePacks.list()[0]!
    applyPacks([{ ...pack, catalog: parsed.catalog, coverage: parsed.coverage }])
    await setMainUiLanguage('es')
    await setRendererUiLanguage('es')
    expect(translateMain('menu.file', 'Updated file menu')).toBe('Updated file menu')
    expect(translate('menu.file', 'File')).toBe('File')
    expect(translateMain('menu.settings', 'Settings')).toBe('Ajustes')
  })

  it('keeps only host-reviewed protected Spanish copy in the core fallback', async () => {
    applyPacks()
    await setMainUiLanguage('es')
    await setRendererUiLanguage('es')
    let checked = 0
    function check(value: object, prefix = ''): void {
      for (const [key, item] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${key}` : key
        if (typeof item === 'string') {
          expect(isProtectedPluginTranslationPath(path), path).toBe(true)
          expect(translateMain(path, 'English security copy')).toBe(item)
          expect(translate(path, 'English security copy')).toBe(item)
          checked++
        } else if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          check(item, path)
        }
      }
    }
    check(security)
    expect(checked).toBeGreaterThan(25)
  })

  it('uses declared CLDR rules for cardinal and ordinal plugin translations in both processes', async () => {
    const id = 'plugin:community.russian/ru-RU' as const
    const pack = {
      id,
      pluginKey: 'community.russian',
      resourceLanguage: pluginLanguageResourceId(id),
      locale: 'ru-RU',
      catalog: {
        sample: {
          count_one: 'one',
          count_few: 'few',
          count_many: 'many',
          count_other: 'other',
          count_ordinal_other: 'ordinal'
        }
      }
    }
    applyPacks([pack])
    await setMainUiLanguage(id)
    await setRendererUiLanguage(id)
    for (const [count, expected] of [
      [1, 'one'],
      [2, 'few'],
      [5, 'many'],
      [21, 'one'],
      [1.5, 'other']
    ] as const) {
      expect(translateMain('sample.count', 'fallback', { count })).toBe(expected)
      expect(translate('sample.count', 'fallback', { count })).toBe(expected)
    }
    expect(translateMain('sample.count', 'fallback', { count: 2, ordinal: true })).toBe('ordinal')
    expect(translate('sample.count', 'fallback', { count: 2, ordinal: true })).toBe('ordinal')
  })

  it('recovers to English when a modern host withdraws the migrated bundle', async () => {
    applyPacks()
    await setMainUiLanguage('es')
    await setRendererUiLanguage('es')
    applyPacks([])
    expect(await setMainUiLanguage('es')).toBe('en')
    await setRendererUiLanguage('es')
    expect(i18n.language).toBe('en')
    expect(translate('menu.file', 'File')).toBe('File')
  })

  it('rejects author-assigned core aliases and unrelated host metadata owners', () => {
    const manifest = service.findValidPlugin('stablyai.orca-syntax-typst')!.manifest
    if (manifest.manifestVersion !== 2) {
      throw new Error('Expected v2 package')
    }
    expect(
      pluginManifestSchema.safeParse({
        ...manifest,
        contributes: {
          ...manifest.contributes,
          languages: manifest.contributes.languages.map((language) => ({
            ...language,
            builtInLanguage: 'typst'
          }))
        }
      }).success
    ).toBe(false)
    const metadata = service.contentPacks.syntaxPacks.list()[0]!
    expect(
      pluginSyntaxPackMetadataSchema.safeParse({
        ...metadata,
        pluginKey: 'community.typst',
        languages: metadata.languages.map((language) => ({
          ...language,
          key: 'syntax:community.typst/typst'
        }))
      }).success
    ).toBe(false)
  })
})
