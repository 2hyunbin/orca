import { describe, expect, it } from 'vitest'
import { SettingsUpdate } from '../rpc-contract/client-settings-params'
import {
  defaultPluginSyntaxSelector,
  isPluginSyntaxLanguageKey,
  normalizePluginSyntaxAssociations,
  pluginSyntaxAssociationsSchema,
  selectedPluginSyntaxAssociation,
  setPluginSyntaxAssociation,
  type PluginSyntaxAssociation
} from './plugin-syntax-associations'

const key = 'syntax:community.syntax-pack/sample'
const rule: PluginSyntaxAssociation = {
  selector: { kind: 'extension', value: '.sample' },
  languageKey: key
}

describe('explicit, persistent syntax associations', () => {
  it('accepts only qualified contribution identities and host-owned fallback choices', () => {
    expect(isPluginSyntaxLanguageKey(key)).toBe(true)
    for (const value of [
      'sample',
      'syntax:sample/one',
      'syntax:community.syntax-pack/one/two',
      'syntax:community.syntax-pack/../worker',
      'orca-plugin-syntax-slot-1'
    ]) {
      expect(isPluginSyntaxLanguageKey(value)).toBe(false)
    }
    expect(
      pluginSyntaxAssociationsSchema.safeParse([rule, { ...rule, languageKey: 'plaintext' }])
        .success
    ).toBe(true)
    expect(
      pluginSyntaxAssociationsSchema.safeParse([{ ...rule, languageKey: 'code.js' }]).success
    ).toBe(false)
  })

  it('rejects paths, author regexes and unexpected executable fields at the settings RPC boundary', () => {
    expect(SettingsUpdate.safeParse({ pluginSyntaxAssociations: [rule] }).success).toBe(true)
    for (const invalid of [
      { ...rule, selector: { kind: 'filename', value: '../Samplefile' } },
      { ...rule, selector: { kind: 'extension', value: '.*' } },
      { ...rule, selector: { kind: 'regex', value: '.*' } },
      { ...rule, main: 'worker.js' }
    ]) {
      expect(SettingsUpdate.safeParse({ pluginSyntaxAssociations: [invalid] }).success).toBe(false)
    }
    expect(
      SettingsUpdate.safeParse({
        pluginSyntaxAssociations: Array.from({ length: 129 }, () => rule)
      }).success
    ).toBe(false)
  })

  it('normalizes old or hand-edited records with bounded traversal and deterministic first-owner selection', () => {
    const result = normalizePluginSyntaxAssociations([
      null,
      { ...rule, selector: { kind: 'extension', value: '.SAMPLE' } },
      { ...rule, languageKey: 'syntax:another.pack/sample' },
      { selector: { kind: 'filename', value: 'Samplefile' }, languageKey: 'auto' }
    ])
    expect(result).toEqual([rule])
    expect(normalizePluginSyntaxAssociations({})).toEqual([])
    expect(
      normalizePluginSyntaxAssociations(
        Array.from({ length: 1000 }, (_, i) => ({
          ...rule,
          selector: { kind: 'extension', value: `.sample${i}` }
        }))
      )
    ).toHaveLength(128)
  })

  it('selects portable basename rules first, then the longest explicit extension', () => {
    const compound: PluginSyntaxAssociation = {
      selector: { kind: 'extension', value: '.sample.md' },
      languageKey: 'plaintext'
    }
    const filename: PluginSyntaxAssociation = {
      selector: { kind: 'filename', value: 'document.sample.md' },
      languageKey: 'syntax:another.pack/sample'
    }
    expect(
      selectedPluginSyntaxAssociation([rule, compound], 'C:\\work\\DOCUMENT.SAMPLE.MD')
    ).toEqual(compound)
    expect(
      selectedPluginSyntaxAssociation([rule, compound, filename], '/remote/DOCUMENT.SAMPLE.MD')
    ).toEqual(filename)
    expect(
      selectedPluginSyntaxAssociation([filename], '/remote/document.sample.md/other.txt')
    ).toBeNull()
  })

  it('uses a compound selector when declared, and a filename selector for extensionless and hidden names', () => {
    expect(defaultPluginSyntaxSelector('/folder/name.sample.md', ['.md', '.sample.md'])).toEqual({
      kind: 'extension',
      value: '.sample.md'
    })
    expect(defaultPluginSyntaxSelector('/folder/name.txt', [])).toEqual({
      kind: 'extension',
      value: '.txt'
    })
    expect(defaultPluginSyntaxSelector('C:\\work\\Samplefile', [])).toEqual({
      kind: 'filename',
      value: 'samplefile'
    })
    expect(defaultPluginSyntaxSelector('/remote/.env', [])).toEqual({
      kind: 'filename',
      value: '.env'
    })
  })

  it('replaces one rule, preserves other choices, and removes a choice when Automatic is selected', () => {
    const filename: PluginSyntaxAssociation = {
      selector: { kind: 'filename', value: 'samplefile' },
      languageKey: key
    }
    const chosen = setPluginSyntaxAssociation([rule, filename], rule.selector, 'plaintext')
    expect(chosen).toEqual([{ ...rule, languageKey: 'plaintext' }, filename])
    expect(setPluginSyntaxAssociation(chosen, rule.selector, 'auto')).toEqual([filename])
  })
})
