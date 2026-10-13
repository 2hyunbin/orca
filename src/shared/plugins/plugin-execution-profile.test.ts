import { describe, expect, it } from 'vitest'
import { parsePluginManifest, pluginManifestV1Schema } from './plugin-manifest'
import { fingerprintPluginConsent } from './plugin-consent-fingerprint'
import { derivePluginExecutionProfile } from './plugin-execution-profile'

function dataManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 2,
    execution: 'data',
    id: 'locale-de',
    publisher: 'community',
    name: 'German',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { languagePacks: [{ locale: 'de', path: 'de.json' }] },
    ...overrides
  }
}

describe('strict plugin execution profiles', () => {
  it('accepts a locale with no executable authority and rejects v2 on the legacy parser', () => {
    const raw = dataManifest()
    const result = parsePluginManifest(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.manifest.capabilities).toEqual([])
    expect(derivePluginExecutionProfile(result.manifest)).toBe('data')
    expect(pluginManifestV1Schema.safeParse(raw).success).toBe(false)
  })

  it.each([
    { main: 'worker.mjs' },
    { capabilities: [{ kind: 'workspace:read' }] },
    { contributes: { panels: [{ id: 'viewer', title: 'Viewer', entry: 'ui.html' }] } },
    { contributes: { commands: [{ id: 'open', title: 'Open', action: 'workspace.openBoard' }] } },
    { contributes: { vmRecipes: [{ path: 'recipe.json' }] } },
    { contributes: { agents: [{ path: 'agent.json' }] } },
    { contributes: { events: [{ on: 'worktree.created' }] } },
    { scripts: { install: 'run me' } },
    { dataOnly: false },
    { engines: { orca: '>=1.0.0', node: '*' } },
    { author: { name: 'Author', permissions: 'all' } }
  ])('rejects executable or unknown data fields: %j', (overrides) => {
    expect(parsePluginManifest(dataManifest(overrides)).ok).toBe(false)
  })

  it('rejects unknown nested panel fields instead of stripping them', () => {
    expect(
      parsePluginManifest(
        dataManifest({
          execution: 'sandboxed-ui',
          contributes: {
            panels: [{ id: 'viewer', title: 'Viewer', entry: 'ui.html', main: 'worker.mjs' }]
          }
        })
      ).ok
    ).toBe(false)
  })

  it.each(['data', 'sandboxed-ui', 'instructional'])('forbids a Node entry for %s', (execution) => {
    expect(parsePluginManifest(dataManifest({ execution, main: 'worker.mjs' })).ok).toBe(false)
  })

  it('requires a Node entry for the full-trust profile', () => {
    expect(parsePluginManifest(dataManifest({ execution: 'trusted-worker' })).ok).toBe(false)
    expect(
      parsePluginManifest(dataManifest({ execution: 'trusted-worker', main: 'worker.mjs' })).ok
    ).toBe(true)
  })

  it('forbids instructional effects in UI packages and UI in instructional packages', () => {
    expect(
      parsePluginManifest(
        dataManifest({
          execution: 'sandboxed-ui',
          contributes: { vmRecipes: [{ path: 'recipe.json' }] }
        })
      ).ok
    ).toBe(false)
    expect(
      parsePluginManifest(
        dataManifest({
          execution: 'instructional',
          contributes: { panels: [{ id: 'ui', title: 'UI', entry: 'ui.html' }] }
        })
      ).ok
    ).toBe(false)
  })

  it('binds approval to the v2 profile while keeping ordinary data updates stable', () => {
    const parse = (raw: unknown) => {
      const result = parsePluginManifest(raw)
      if (!result.ok) {
        throw new Error(result.error)
      }
      return result.manifest
    }
    const data = parse(dataManifest())
    const ui = parse(dataManifest({ execution: 'sandboxed-ui' }))
    const legacy = parse(dataManifest({ manifestVersion: 1, execution: undefined }))
    expect(fingerprintPluginConsent(data)).not.toBe(fingerprintPluginConsent(ui))
    expect(fingerprintPluginConsent(data)).not.toBe(fingerprintPluginConsent(legacy))
    expect(fingerprintPluginConsent(data)).toBe(
      fingerprintPluginConsent(parse(dataManifest({ version: '1.1.0' })))
    )
  })
})
