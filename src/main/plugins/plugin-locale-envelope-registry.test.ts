import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginLocaleEnvelope } from '../../shared/plugins/plugin-locale-envelope'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { getPluginLocaleKit } from './plugin-locale-source'
import { inspectPluginInstallTree } from './plugin-install-staging'
import { PluginContentVerifier } from './plugin-content-integrity'
import { PluginLanguagePackRegistry } from './plugin-language-pack-registry'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function sample() {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-maintained-locale-'))
  roots.push(rootDir)
  const kit = await getPluginLocaleKit()
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 2,
    execution: 'data',
    id: 'locale-de',
    publisher: 'community',
    name: 'German',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { languagePacks: [{ locale: 'de', path: 'de.json' }] }
  })
  await mkdir(rootDir, { recursive: true })
  await writeFile(join(rootDir, 'orca-plugin.json'), JSON.stringify(manifest))
  const envelope = createPluginLocaleEnvelope({
    kit,
    locale: 'de',
    displayName: 'Deutsch',
    translations: { 'menu.file': 'Datei' }
  })
  await writeFile(join(rootDir, 'de.json'), JSON.stringify(envelope))
  const plugin = {
    rootDir,
    manifest,
    pluginKey: 'community.locale-de',
    consentFingerprint: fingerprintPluginConsent(manifest),
    contentHash: null,
    isDev: true
  }
  return { plugin, kit, envelope }
}

describe('maintained locales through install and activation', () => {
  it('projects current coverage, loads only approved data and withdraws disabled resources', async () => {
    const { plugin } = await sample()
    expect(
      await inspectPluginInstallTree({ rootDir: plugin.rootDir, hostVersion: '1.0.0' })
    ).toMatchObject({ ok: true })
    const registry = new PluginLanguagePackRegistry(new PluginContentVerifier())
    await registry.reconcile([plugin], () => false)
    expect(registry.list()).toEqual([])
    await registry.reconcile([plugin], () => true)
    expect(registry.list()).toMatchObject([
      {
        displayName: 'Deutsch',
        catalog: { menu: { file: 'Datei' } },
        coverage: { current: 1, stale: 0 }
      }
    ])
    await registry.reconcile([plugin], () => false)
    expect(registry.list()).toEqual([])
  })
  it('excludes stale entries from the effective resource while reporting drift', async () => {
    const { plugin, envelope } = await sample()
    envelope.entries['menu.file']!.sourceHash = `sha256:${'0'.repeat(64)}`
    await writeFile(join(plugin.rootDir, 'de.json'), JSON.stringify(envelope))
    const registry = new PluginLanguagePackRegistry(new PluginContentVerifier())
    await registry.reconcile([plugin], () => true)
    expect(registry.list()).toMatchObject([{ catalog: {}, coverage: { current: 0, stale: 1 } }])
  })
  it('rejects protected security overrides at staging before publication and activation', async () => {
    const { plugin, envelope } = await sample()
    envelope.entries['auto.components.settings.PluginCatalogDetail.workerDescription'] = {
      value: 'Safe language data',
      sourceHash: `sha256:${'0'.repeat(64)}`
    }
    await writeFile(join(plugin.rootDir, 'de.json'), JSON.stringify(envelope))
    expect(
      await inspectPluginInstallTree({ rootDir: plugin.rootDir, hostVersion: '1.0.0' })
    ).toMatchObject({ ok: false, error: expect.stringContaining('protected security copy') })
    const registry = new PluginLanguagePackRegistry(new PluginContentVerifier())
    await registry.reconcile([plugin], () => true)
    expect(registry.list()).toEqual([])
    expect(registry.error(plugin.pluginKey)).toContain('protected security copy')
  })
})
