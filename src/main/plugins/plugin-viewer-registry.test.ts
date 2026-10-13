import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { PLUGIN_VIEWER_ENTRY_BYTES } from '../../shared/plugins/plugin-viewer-contributions'
import { PluginContentVerifier } from './plugin-content-integrity'
import { discoverPluginConsent } from './plugin-discovery-consent'
import { PluginViewerRegistry } from './plugin-viewer-registry'
import { inspectPluginInstallTree } from './plugin-install-staging'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-viewer-pack-'))
  roots.push(rootDir)
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 2,
    execution: 'sandboxed-ui',
    id: 'workbook',
    publisher: 'community',
    name: 'Workbook',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: {
      fileViewers: [
        {
          id: 'workbook',
          displayName: 'Workbook',
          selector: [{ filenamePattern: '**/*.xlsx' }],
          entry: 'dist/workbook.worker.js',
          rendering: 'host-ui',
          mode: 'readonly'
        }
      ]
    }
  })
  await mkdir(join(rootDir, 'dist'))
  await writeFile(join(rootDir, 'orca-plugin.json'), JSON.stringify(manifest))
  const entry = join(rootDir, 'dist', 'workbook.worker.js')
  const source = 'throw new Error("This must never execute during discovery or validation")'
  await writeFile(entry, source)
  const consent = await discoverPluginConsent({
    rootDir,
    pluginKey: 'community.workbook',
    manifest,
    isDev: true
  })
  return {
    rootDir,
    entry,
    source,
    plugin: {
      rootDir,
      manifest,
      pluginKey: 'community.workbook',
      contentHash: null,
      isDev: true,
      ...consent
    }
  }
}

describe('approved viewer metadata and source', () => {
  it('validates inert worker bytes and exposes names without executable code or private paths', async () => {
    const setup = await fixture()
    expect(
      await inspectPluginInstallTree({ rootDir: setup.rootDir, hostVersion: '1.0.0' })
    ).toMatchObject({ ok: true })
    const registry = new PluginViewerRegistry(new PluginContentVerifier(), () => true)
    await registry.reconcile([setup.plugin], () => true)
    const [metadata] = registry.list()
    expect(metadata).toMatchObject({ key: 'viewer:community.workbook/workbook', mode: 'readonly' })
    expect(JSON.stringify(metadata)).not.toContain(setup.rootDir)
    expect(metadata).not.toHaveProperty('entry')
    expect(metadata).not.toHaveProperty('source')
    expect(await registry.loadSource(metadata.key, metadata.revision, metadata.generation)).toBe(
      setup.source
    )
    expect(await registry.loadSource(metadata.key, 'wrong-release', metadata.generation)).toBeNull()
    expect(
      await registry.loadSource(metadata.key, metadata.revision, metadata.generation + 1)
    ).toBeNull()
  })

  it('keeps metadata activation separate from readiness during registry reconciliation', async () => {
    const setup = await fixture()
    let ready = false
    const registry = new PluginViewerRegistry(new PluginContentVerifier(), () => ready)
    await registry.reconcile([setup.plugin], () => true)
    expect(registry.list()).toEqual([])
    ready = true
    expect(registry.list()).toHaveLength(1)
  })

  it('does not admit an unapproved viewer and withdraws a previously approved source immediately', async () => {
    const setup = await fixture()
    let approved = false
    const registry = new PluginViewerRegistry(new PluginContentVerifier(), () => approved)
    await registry.reconcile([setup.plugin], () => approved)
    expect(registry.list()).toEqual([])
    approved = true
    await registry.reconcile([setup.plugin], () => approved)
    const [metadata] = registry.list()
    approved = false
    expect(registry.list()).toEqual([])
    expect(registry.isCurrent(metadata.key, metadata.revision, metadata.generation)).toBe(false)
    expect(
      await registry.loadSource(metadata.key, metadata.revision, metadata.generation)
    ).toBeNull()
  })

  it('preserves an unchanged viewer generation across unrelated refreshes but not disable/re-enable', async () => {
    const setup = await fixture()
    const registry = new PluginViewerRegistry(new PluginContentVerifier(), () => true)
    await registry.reconcile([setup.plugin], () => true)
    const first = registry.list()[0]
    await registry.reconcile([{ ...setup.plugin }], () => true)
    expect(registry.list()[0].generation).toBe(first.generation)
    await registry.reconcile([], () => true)
    await registry.reconcile([setup.plugin], () => true)
    expect(registry.list()[0].generation).toBeGreaterThan(first.generation)
    expect(registry.isCurrent(first.key, first.revision, first.generation)).toBe(false)
  })

  it('cannot inherit source authority from a different publisher with the same local viewer id', async () => {
    const setup = await fixture()
    const registry = new PluginViewerRegistry(new PluginContentVerifier(), () => true)
    await registry.reconcile([setup.plugin], () => true)
    const first = registry.list()[0]
    expect(
      await registry.loadSource('viewer:other.workbook/workbook', first.revision, first.generation)
    ).toBeNull()
    first.selector[0].filenamePattern = '*'
    expect(registry.list()[0].selector[0].filenamePattern).toBe('**/*.xlsx')
  })

  it('rejects changed development source bytes before they can enter a worker', async () => {
    const setup = await fixture()
    const registry = new PluginViewerRegistry(new PluginContentVerifier(), () => true)
    await registry.reconcile([setup.plugin], () => true)
    const first = registry.list()[0]
    await writeFile(setup.entry, 'self.postMessage("unreviewed")')
    await expect(registry.loadSource(first.key, first.revision, first.generation)).rejects.toThrow(
      'content changed'
    )
  })

  it('refuses absent, oversized, non-UTF8 and empty worker artifacts', async () => {
    const setup = await fixture()
    await truncate(setup.entry, PLUGIN_VIEWER_ENTRY_BYTES + 1)
    expect(
      await inspectPluginInstallTree({ rootDir: setup.rootDir, hostVersion: '1.0.0' })
    ).toMatchObject({ ok: false, error: expect.stringContaining('artifact limit') })
    await writeFile(setup.entry, Buffer.from([0xff, 0xfe, 0x00]))
    expect(
      await inspectPluginInstallTree({ rootDir: setup.rootDir, hostVersion: '1.0.0' })
    ).toMatchObject({ ok: false })
    await writeFile(setup.entry, ' \n')
    expect(
      await inspectPluginInstallTree({ rootDir: setup.rootDir, hostVersion: '1.0.0' })
    ).toMatchObject({ ok: false, error: expect.stringContaining('empty') })
    await rm(setup.entry)
    expect(
      await inspectPluginInstallTree({ rootDir: setup.rootDir, hostVersion: '1.0.0' })
    ).toMatchObject({ ok: false })
  })

  it('rejects a declared worker symlink outside the package', async () => {
    const setup = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'orca-viewer-outside-'))
    roots.push(outside)
    await writeFile(join(outside, 'secret.js'), 'throw new Error("outside")')
    await rm(setup.entry)
    await symlink(join(outside, 'secret.js'), setup.entry)
    expect(
      await inspectPluginInstallTree({ rootDir: setup.rootDir, hostVersion: '1.0.0' })
    ).toMatchObject({ ok: false, error: expect.stringContaining('outside the plugin') })
    const registry = new PluginViewerRegistry(new PluginContentVerifier(), () => true)
    await registry.reconcile([setup.plugin], () => true)
    expect(registry.list()).toEqual([])
  })
})
