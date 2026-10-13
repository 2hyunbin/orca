import { describe, expect, it } from 'vitest'
import { createPluginLocaleKit, diffPluginLocaleKits } from './plugin-locale-kit'
import { createPluginLocaleEnvelope, parsePluginLocaleEnvelope } from './plugin-locale-envelope'

const kit = createPluginLocaleKit({
  menu: { file: 'File', greeting: 'Hello {{name}}', missing: 'Missing' },
  auto: { components: { settings: { PluginConsentDialog: { disclaimer: 'Full access' } } } }
})
const envelope = createPluginLocaleEnvelope({
  kit,
  locale: 'de',
  displayName: 'Deutsch',
  translations: { 'menu.file': 'Datei', 'menu.greeting': 'Hallo {{name}}' }
})

describe('maintained locale envelopes', () => {
  it('exports stable source fingerprints and excludes core-owned security copy', () => {
    expect(Object.keys(kit.entries)).toEqual(['menu.file', 'menu.greeting', 'menu.missing'])
    expect(
      createPluginLocaleKit({
        menu: { missing: 'Missing', greeting: 'Hello {{name}}', file: 'File' }
      })
    ).toEqual(kit)
  })
  it('loads current translations and reports eligible coverage separately from stale entries', () => {
    const result = parsePluginLocaleEnvelope(JSON.stringify(envelope), 'de', kit)
    expect(result.catalog).toEqual({ menu: { file: 'Datei', greeting: 'Hallo {{name}}' } })
    expect(result.coverage).toEqual({ eligible: 3, current: 2, stale: 0, obsolete: 0, missing: 1 })
  })
  it('drops changed source and obsolete keys while retaining current translations', () => {
    const changedKit = createPluginLocaleKit({
      menu: { file: 'File', greeting: 'Welcome {{name}}', new: 'New' }
    })
    const withOld = {
      ...envelope,
      entries: {
        ...envelope.entries,
        removed: { sourceHash: kit.entries['menu.file']!.sourceHash, value: 'Gone' }
      }
    }
    const result = parsePluginLocaleEnvelope(JSON.stringify(withOld), 'de', changedKit)
    expect(result.catalog).toEqual({ menu: { file: 'Datei' } })
    expect(result.coverage).toEqual({ eligible: 3, current: 1, stale: 1, obsolete: 1, missing: 1 })
    expect(diffPluginLocaleKits(kit, changedKit)).toEqual({
      added: ['menu.new'],
      changed: ['menu.greeting'],
      removed: ['menu.missing']
    })
  })
  it('rejects false locale declarations and placeholder changes', () => {
    expect(() => parsePluginLocaleEnvelope(JSON.stringify(envelope), 'fr', kit)).toThrow(
      'locale envelope'
    )
    const broken = {
      ...envelope,
      entries: {
        'menu.greeting': { ...envelope.entries['menu.greeting'], value: 'Hallo {{secret}}' }
      }
    }
    expect(() => parsePluginLocaleEnvelope(JSON.stringify(broken), 'de', kit)).toThrow(
      'placeholders'
    )
  })
  it.each([
    '__proto__.polluted',
    'menu.constructor.bad',
    'menu..file',
    'menu.file.extra',
    'auto.components.settings.PluginConsentDialog.disclaimer'
  ])('rejects unsafe or protected keys: %s', (key) => {
    const bad = {
      ...envelope,
      entries: {
        ...envelope.entries,
        [key]: { sourceHash: kit.entries['menu.file']!.sourceHash, value: 'Unsafe' }
      }
    }
    expect(() => parsePluginLocaleEnvelope(JSON.stringify(bad), 'de', kit)).toThrow()
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false)
  })
  it('rejects legacy JSON, unknown fields and oversized or deeply nested envelopes', () => {
    expect(() => parsePluginLocaleEnvelope('{"menu":{"file":"Datei"}}', 'de', kit)).toThrow()
    expect(() =>
      parsePluginLocaleEnvelope(JSON.stringify({ ...envelope, script: 'worker.mjs' }), 'de', kit)
    ).toThrow()
    expect(() => parsePluginLocaleEnvelope(' '.repeat(5 * 1024 * 1024 + 1), 'de', kit)).toThrow(
      '5 MiB'
    )
    const deep = {
      ...envelope,
      entries: {
        [`${'a.'.repeat(18)}leaf`]: {
          sourceHash: kit.entries['menu.file']!.sourceHash,
          value: 'Deep'
        }
      }
    }
    expect(() => parsePluginLocaleEnvelope(JSON.stringify(deep), 'de', kit)).toThrow('depth')
  })
})
