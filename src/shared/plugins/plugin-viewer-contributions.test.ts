import { describe, expect, it } from 'vitest'
import { pluginManifestSchema } from './plugin-manifest'
import { fingerprintPluginConsent } from './plugin-consent-fingerprint'
import { pluginCatalogTypes } from './plugin-catalog-release'
import {
  pluginViewerContributionSchema,
  pluginViewerSelectorMatches
} from './plugin-viewer-contributions'
import { pluginViewerKey, pluginViewerMetadataSchema } from './plugin-viewer-package'

const sampleViewerContribution = {
  id: 'workbook',
  displayName: 'Workbook',
  selector: [{ filenamePattern: '**/*.xlsx' }],
  entry: 'dist/workbook.worker.js',
  rendering: 'host-ui',
  mode: 'readonly'
} as const

function manifest(
  execution = 'sandboxed-ui',
  fileViewers: readonly unknown[] = [sampleViewerContribution]
) {
  return {
    manifestVersion: 2,
    execution,
    publisher: 'community',
    id: 'file-formats',
    name: 'File formats',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { fileViewers }
  }
}

describe('strict generic file-viewer declarations', () => {
  it('classifies browser parser code separately from data and Node workers', () => {
    const parsed = pluginManifestSchema.parse(manifest())
    expect(parsed.main).toBeUndefined()
    expect(pluginCatalogTypes(parsed)).toEqual(['file-viewer'])
    expect(pluginManifestSchema.safeParse(manifest('data')).success).toBe(false)
    expect(pluginManifestSchema.safeParse(manifest('instructional')).success).toBe(false)
    expect(pluginManifestSchema.safeParse({ ...manifest(), manifestVersion: 1 }).success).toBe(
      false
    )
  })

  it.each([
    { entry: '../outside.js' },
    { entry: '/absolute.js' },
    { entry: 'dist/viewer.html' },
    { rendering: 'html' },
    { mode: 'readwrite' },
    { network: true },
    { selector: [] },
    { selector: [{ filenamePattern: '*.xlsx', regex: '.*' }] },
    { selector: [{ filenamePattern: '[ab].xlsx' }] },
    { selector: [{ filenamePattern: '*a*b*.xlsx' }] },
    { selector: [{ filenamePattern: 'folder/**/*.xlsx' }] },
    { selector: [{ filenamePattern: 'a'.repeat(257) }] }
  ])('rejects unknown authority, non-worker entries and unbounded patterns: %j', (change) => {
    expect(
      pluginViewerContributionSchema.safeParse({ ...sampleViewerContribution, ...change }).success
    ).toBe(false)
  })

  it('bounds viewers/selectors and rejects duplicate identities and patterns', () => {
    expect(
      pluginManifestSchema.safeParse(
        manifest(
          'sandboxed-ui',
          Array.from({ length: 17 }, () => ({ ...sampleViewerContribution }))
        )
      ).success
    ).toBe(false)
    expect(
      pluginManifestSchema.safeParse(
        manifest('sandboxed-ui', [sampleViewerContribution, sampleViewerContribution])
      ).success
    ).toBe(false)
    expect(
      pluginViewerContributionSchema.safeParse({
        ...sampleViewerContribution,
        selector: Array.from({ length: 17 }, () => ({ filenamePattern: '*.xlsx' }))
      }).success
    ).toBe(false)
    const duplicate = {
      ...sampleViewerContribution,
      selector: [{ filenamePattern: '*.xlsx' }, { filenamePattern: '*.XLSX' }]
    }
    expect(pluginManifestSchema.safeParse(manifest('sandboxed-ui', [duplicate])).success).toBe(
      false
    )
  })

  it.each([
    ['**/*.xlsx', '/workspace/data/BOOK.XLSX', true],
    ['*.xlsx', 'C:\\folder\\book.xlsx', true],
    ['*.xlsx', '/workspace/book.xlsx.txt', false],
    ['data-*.bin', '/workspace/data-sample.bin', true],
    ['data-*.bin', '/workspace/other-sample.bin', false],
    ['README.?d', '/workspace/README.md', true],
    ['📄.bin', '/workspace/📄.bin', true],
    ['?.bin', '/workspace/📄.bin', true],
    ['*', '/workspace/arbitrary-format', true],
    ['*a*a*', '/workspace/aaaa!', false]
  ])('matches portable bounded filename globs: %s / %s', (filenamePattern, file, expected) => {
    expect(pluginViewerSelectorMatches({ filenamePattern }, file)).toBe(expected)
  })

  it('requires new file-reading approval even for an already approved UI package', () => {
    const before = pluginManifestSchema.parse({
      ...manifest('sandboxed-ui', []),
      contributes: { panels: [{ id: 'summary', title: 'Summary', entry: 'summary.html' }] }
    })
    const after = pluginManifestSchema.parse({
      ...before,
      contributes: { ...before.contributes, fileViewers: [sampleViewerContribution] }
    })
    expect(fingerprintPluginConsent(after)).not.toBe(fingerprintPluginConsent(before))
  })

  it('projects qualified metadata without source code or entry paths', () => {
    const { entry: _entry, ...contribution } = sampleViewerContribution
    const metadata = {
      ...contribution,
      pluginKey: 'community.file-formats',
      key: pluginViewerKey('community.file-formats', contribution.id),
      pluginName: 'File formats',
      revision: 'release-hash',
      generation: 1
    }
    expect(pluginViewerMetadataSchema.safeParse(metadata).success).toBe(true)
    expect(pluginViewerMetadataSchema.safeParse({ ...metadata, entry: 'hidden.js' }).success).toBe(
      false
    )
    expect(
      pluginViewerMetadataSchema.safeParse({ ...metadata, key: 'viewer:other.publisher/workbook' })
        .success
    ).toBe(false)
  })
})
