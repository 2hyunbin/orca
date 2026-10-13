import { describe, expect, it } from 'vitest'
import { getPluginFileOpeningPlan } from './plugin-file-opening-plan'
import type { PluginFileViewerRegistry } from '@/store/plugin-file-viewers'
import type { PluginViewerMetadata } from '../../../shared/plugins/plugin-viewer-package'

const viewer: PluginViewerMetadata = {
  key: 'viewer:community.viewer/sample',
  pluginKey: 'community.viewer',
  pluginName: 'Sample',
  id: 'sample',
  displayName: 'Sample viewer',
  revision: 'release-1',
  generation: 1,
  selector: [{ filenamePattern: '*.sample' }],
  rendering: 'host-ui',
  mode: 'readonly'
}
const registry: PluginFileViewerRegistry = { status: 'ready', viewers: [viewer], syntaxPacks: [] }
const settings = { pluginViewerAssociations: [], pluginSyntaxAssociations: [] }

describe('normal file opening policy', () => {
  it('waits for settings and approved metadata before choosing an unknown format', () => {
    expect(getPluginFileOpeningPlan('/work/file.sample', null, registry)).toEqual({
      kind: 'loading'
    })
    for (const status of ['idle', 'loading'] as const) {
      expect(
        getPluginFileOpeningPlan('/work/file.sample', settings, { ...registry, status })
      ).toEqual({ kind: 'loading' })
    }
  })
  it.each([
    'source.ts',
    'SOURCE.TXT',
    'Dockerfile',
    'photo.png',
    'photo.avif',
    'paper.pdf',
    'clip.mp4'
  ])('preserves the core handler for %s even while metadata loads', (name) => {
    expect(
      getPluginFileOpeningPlan(`/work/${name}`, settings, {
        ...registry,
        status: 'loading',
        viewers: [{ ...viewer, selector: [{ filenamePattern: '*' }] }]
      })
    ).toEqual({ kind: 'core' })
  })
  it('opens the only approved match and requires an explicit choice for conflicts', () => {
    expect(getPluginFileOpeningPlan('C:\\work\\FILE.SAMPLE', settings, registry)).toEqual({
      kind: 'plugin',
      viewer
    })
    const other = { ...viewer, key: 'viewer:another.viewer/sample', pluginKey: 'another.viewer' }
    expect(
      getPluginFileOpeningPlan('/work/file.sample', settings, {
        ...registry,
        viewers: [viewer, other]
      })
    ).toEqual({ kind: 'choose' })
    expect(getPluginFileOpeningPlan('/work/file.unknown', settings, registry)).toEqual({
      kind: 'core'
    })
  })
  it('honors an explicit saved viewer before a known core format', () => {
    const txt = { ...viewer, selector: [{ filenamePattern: '*.txt' }] }
    expect(
      getPluginFileOpeningPlan(
        '/work/file.txt',
        {
          ...settings,
          pluginViewerAssociations: [
            { selector: { kind: 'extension', value: '.txt' }, viewerKey: viewer.key }
          ]
        },
        { ...registry, viewers: [txt] }
      )
    ).toEqual({ kind: 'plugin', viewer: txt })
  })
  it('honors saved Orca even if metadata fails and reports a missing exact publisher', () => {
    const selector = { kind: 'extension' as const, value: '.sample' }
    expect(
      getPluginFileOpeningPlan(
        '/work/file.sample',
        { ...settings, pluginViewerAssociations: [{ selector, viewerKey: 'core' }] },
        { ...registry, status: 'failed' }
      )
    ).toEqual({ kind: 'core' })
    const saved = {
      ...settings,
      pluginViewerAssociations: [{ selector, viewerKey: 'viewer:missing.viewer/sample' }]
    }
    expect(getPluginFileOpeningPlan('/work/file.sample', saved, registry)).toEqual({
      kind: 'missing',
      viewerKey: 'viewer:missing.viewer/sample'
    })
    expect(
      getPluginFileOpeningPlan('/work/file.sample', saved, { ...registry, status: 'unsupported' })
    ).toEqual({ kind: 'unsupported' })
  })
  it('protects an explicit syntax choice, including a temporarily absent pack', () => {
    expect(
      getPluginFileOpeningPlan(
        '/work/file.sample',
        {
          ...settings,
          pluginSyntaxAssociations: [
            {
              selector: { kind: 'extension', value: '.sample' },
              languageKey: 'syntax:missing.syntax/sample'
            }
          ]
        },
        registry
      )
    ).toEqual({ kind: 'core' })
  })
  it('protects a matching approved syntax pack from automatic parser takeover', () => {
    expect(
      getPluginFileOpeningPlan('/work/file.sample', settings, {
        ...registry,
        syntaxPacks: [
          {
            pluginKey: 'community.syntax',
            name: 'Sample syntax',
            revision: 'release-1',
            languages: [
              {
                key: 'syntax:community.syntax/sample',
                id: 'sample',
                aliases: ['Sample'],
                filenames: [],
                extensions: ['.sample'],
                scopeName: 'source.sample'
              }
            ]
          }
        ]
      })
    ).toEqual({ kind: 'core' })
  })
  it('distinguishes metadata failure from an empty registry and supports older APIs', () => {
    expect(
      getPluginFileOpeningPlan('/work/file.sample', settings, {
        ...registry,
        status: 'failed',
        viewers: []
      })
    ).toEqual({ kind: 'failed' })
    expect(
      getPluginFileOpeningPlan('/work/file.sample', settings, { ...registry, viewers: [] })
    ).toEqual({ kind: 'core' })
    expect(
      getPluginFileOpeningPlan('/work/file.sample', null, { ...registry, status: 'unsupported' })
    ).toEqual({ kind: 'core' })
  })
})
