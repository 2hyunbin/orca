import { describe, expect, it } from 'vitest'
import { pluginManifestSchema } from './plugin-manifest'
import { derivePluginExecutionProfile } from './plugin-execution-profile'
import {
  fingerprintPluginConsent,
  hasInstructionalPluginContributions
} from './plugin-consent-fingerprint'
import { getPluginActivationState } from './plugin-consent-state'
import { pluginCatalogReleaseSchema, pluginCatalogTypes } from './plugin-catalog-release'

const manifest = {
  manifestVersion: 2,
  execution: 'instructional',
  publisher: 'company',
  id: 'devpods',
  name: 'Development pods',
  version: '1.0.0',
  engines: { orca: '>=1.4.0' },
  pluginApi: 1,
  contributes: { environmentRecipes: [{ path: 'recipes/devpods.json' }] }
}

describe('environment providers are explicit executable contributions', () => {
  it('accepts a strict v2 recipe and derives its instructional/catalog boundary', () => {
    const parsed = pluginManifestSchema.parse(manifest)
    expect(parsed.contributes.vmRecipes).toEqual([])
    expect(derivePluginExecutionProfile(parsed)).toBe('instructional')
    expect(hasInstructionalPluginContributions(parsed)).toBe(true)
    expect(pluginCatalogTypes(parsed)).toEqual(['environment-provider'])
  })
  it.each(['data', 'sandboxed-ui'])(
    'refuses environment commands inside %s packages',
    (execution) => {
      expect(pluginManifestSchema.safeParse({ ...manifest, execution }).success).toBe(false)
    }
  )
  it('does not add environment commands to legacy manifests or accept undeclared fields', () => {
    expect(pluginManifestSchema.safeParse({ ...manifest, manifestVersion: 1 }).success).toBe(false)
    expect(
      pluginManifestSchema.safeParse({
        ...manifest,
        contributes: {
          environmentRecipes: [{ path: 'recipes/devpods.json', command: 'hidden-command' }]
        }
      }).success
    ).toBe(false)
  })
  it.each(['/outside.json', '../escape.json', 'C:\\escape.json', '\\\\server\\recipe.json'])(
    'rejects nonportable/escaping artifact paths: %s',
    (path) => {
      expect(
        pluginManifestSchema.safeParse({
          ...manifest,
          contributes: { environmentRecipes: [{ path }] }
        }).success
      ).toBe(false)
    }
  )
  it('rejects duplicate paths and excessive recipe contributions', () => {
    expect(
      pluginManifestSchema.safeParse({
        ...manifest,
        contributes: {
          environmentRecipes: [{ path: 'recipes/devpods.json' }, { path: 'recipes/devpods.json' }]
        }
      }).success
    ).toBe(false)
    expect(
      pluginManifestSchema.safeParse({
        ...manifest,
        contributes: {
          environmentRecipes: Array.from({ length: 65 }, (_, i) => ({ path: `recipes/${i}.json` }))
        }
      }).success
    ).toBe(false)
  })
  it('requires fresh consent when a language pack is promoted into an environment provider', () => {
    const data = pluginManifestSchema.parse({
      ...manifest,
      execution: 'data',
      contributes: {
        languagePacks: [{ locale: 'de', path: 'de.json' }]
      }
    })
    const provider = pluginManifestSchema.parse(manifest)
    const source = {
      kind: 'git',
      url: 'https://example.com/company/devpods.git',
      ref: 'v1.0.0'
    } as const
    const old = fingerprintPluginConsent(data, 'a'.repeat(64), source)
    const next = fingerprintPluginConsent(provider, 'a'.repeat(64), source)
    expect(next).not.toBe(old)
    expect(
      getPluginActivationState('company.devpods', next, {
        pluginConsents: { 'company.devpods': old },
        disabledPlugins: []
      })
    ).toBe('pending')
    expect(fingerprintPluginConsent(provider, 'b'.repeat(64), source)).not.toBe(next)
  })
  it('rejects misleading data-only catalog metadata for an environment provider', () => {
    const release = {
      version: '1.0.0',
      commit: 'a'.repeat(40),
      contentHash: 'b'.repeat(64),
      minimumOrca: '1.4.0',
      types: ['environment-provider'],
      license: 'MIT'
    }
    expect(pluginCatalogReleaseSchema.safeParse({ ...release, execution: 'data' }).success).toBe(
      false
    )
    expect(
      pluginCatalogReleaseSchema.safeParse({ ...release, execution: 'instructional' }).success
    ).toBe(true)
  })
})
