import { describe, expect, it } from 'vitest'
import { SettingsUpdate } from '../rpc-contract/client-settings-params'
import {
  defaultPluginViewerSelector,
  isPluginViewerKey,
  normalizePluginViewerAssociations,
  selectedPluginViewerAssociation,
  setPluginViewerAssociation,
  type PluginViewerAssociation
} from './plugin-viewer-associations'

const rule: PluginViewerAssociation = {
  selector: { kind: 'extension', value: '.sample' },
  viewerKey: 'viewer:community.viewer/sample'
}

describe('bounded viewer defaults', () => {
  it('accepts only qualified viewer identities or Orca at the settings boundary', () => {
    expect(isPluginViewerKey(rule.viewerKey)).toBe(true)
    expect(SettingsUpdate.safeParse({ pluginViewerAssociations: [rule] }).success).toBe(true)
    expect(
      SettingsUpdate.safeParse({ pluginViewerAssociations: [{ ...rule, viewerKey: 'core' }] })
        .success
    ).toBe(true)
    for (const viewerKey of [
      'sample',
      'auto',
      'worker.js',
      'viewer:sample/one',
      'viewer:community.viewer/one/two',
      'viewer:community.viewer/../worker'
    ]) {
      expect(
        SettingsUpdate.safeParse({ pluginViewerAssociations: [{ ...rule, viewerKey }] }).success
      ).toBe(false)
    }
  })
  it('rejects paths, regexes, control characters, authority fields and oversized settings', () => {
    for (const selector of [
      { kind: 'filename', value: '../secret' },
      { kind: 'filename', value: 'C:\\secret' },
      { kind: 'filename', value: 'a\u0000b' },
      { kind: 'extension', value: '.*' },
      { kind: 'regex', value: '(.*)+' }
    ]) {
      expect(
        SettingsUpdate.safeParse({ pluginViewerAssociations: [{ ...rule, selector }] }).success
      ).toBe(false)
    }
    expect(
      SettingsUpdate.safeParse({ pluginViewerAssociations: [{ ...rule, worker: 'execute.js' }] })
        .success
    ).toBe(false)
    expect(
      SettingsUpdate.safeParse({
        pluginViewerAssociations: Array.from({ length: 129 }, () => rule)
      }).success
    ).toBe(false)
  })
  it('normalizes bounded hand-edited input while retaining the first exact owner', () => {
    expect(
      normalizePluginViewerAssociations([
        null,
        { ...rule, selector: { kind: 'extension', value: '.SAMPLE' } },
        { ...rule, viewerKey: 'viewer:another.viewer/sample' }
      ])
    ).toEqual([rule])
    expect(normalizePluginViewerAssociations({})).toEqual([])
    expect(
      normalizePluginViewerAssociations(
        Array.from({ length: 1000 }, (_, i) => ({
          ...rule,
          selector: { kind: 'extension', value: `.sample${i}` }
        }))
      )
    ).toHaveLength(128)
  })
  it('prefers a portable literal filename over the longest matching extension', () => {
    const compound: PluginViewerAssociation = {
      selector: { kind: 'extension', value: '.sample.md' },
      viewerKey: 'core'
    }
    const filename: PluginViewerAssociation = {
      selector: { kind: 'filename', value: 'document.sample.md' },
      viewerKey: rule.viewerKey
    }
    expect(
      selectedPluginViewerAssociation([rule, compound], 'C:\\work\\DOCUMENT.SAMPLE.MD')
    ).toEqual(compound)
    expect(
      selectedPluginViewerAssociation([rule, compound, filename], '/remote/DOCUMENT.SAMPLE.MD')
    ).toEqual(filename)
    expect(
      selectedPluginViewerAssociation([filename], '/remote/document.sample.md/other.txt')
    ).toBeNull()
  })
  it('uses declared compound extensions and exact names without persisting globs', () => {
    expect(
      defaultPluginViewerSelector('/work/document.sample.md', {
        selector: [{ filenamePattern: '*.md' }, { filenamePattern: '**/*.sample.md' }]
      })
    ).toEqual({ kind: 'extension', value: '.sample.md' })
    expect(
      defaultPluginViewerSelector('/work/document.sample.md', {
        selector: [{ filenamePattern: 'document.sample.md' }]
      })
    ).toEqual({ kind: 'filename', value: 'document.sample.md' })
    expect(defaultPluginViewerSelector('C:\\work\\.env')).toEqual({
      kind: 'filename',
      value: '.env'
    })
    expect(defaultPluginViewerSelector('/work/a:invalid')).toBeNull()
  })
  it('sets and resets one scope without discarding other defaults or mutating caller input', () => {
    const unrelated: PluginViewerAssociation = {
      selector: { kind: 'extension', value: '.other' },
      viewerKey: 'core'
    }
    const input = [rule, unrelated]
    expect(setPluginViewerAssociation(input, rule.selector, 'core')).toEqual([
      { ...rule, viewerKey: 'core' },
      unrelated
    ])
    expect(setPluginViewerAssociation(input, rule.selector, 'auto')).toEqual([unrelated])
    expect(input).toEqual([rule, unrelated])
  })
})
