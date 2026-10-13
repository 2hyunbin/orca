import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginSyntaxPackPayloadSchema } from '../../shared/plugins/plugin-syntax-pack'
import { PluginContentVerifier } from './plugin-content-integrity'
import { inspectPluginInstallTree } from './plugin-install-staging'
import { PluginSyntaxPackRegistry } from './plugin-syntax-pack-registry'
import { hashPluginTree } from './plugin-content-hash'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function sample() {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-syntax-pack-'))
  roots.push(rootDir)
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 2,
    execution: 'data',
    id: 'syntax-sample',
    publisher: 'community',
    name: 'Sample syntax',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: {
      languages: [{ id: 'sample', extensions: ['.sample'], configuration: 'configuration.json' }],
      grammars: [{ language: 'sample', scopeName: 'source.sample', path: 'sample.json' }]
    }
  })
  await writeFile(join(rootDir, 'orca-plugin.json'), JSON.stringify(manifest))
  await writeFile(join(rootDir, 'configuration.json'), JSON.stringify({ brackets: [['(', ')']] }))
  await writeFile(
    join(rootDir, 'sample.json'),
    JSON.stringify({
      scopeName: 'source.sample',
      patterns: [{ match: '\\bword\\b', name: 'keyword' }]
    })
  )
  return {
    rootDir,
    manifest,
    pluginKey: 'community.syntax-sample',
    consentFingerprint: fingerprintPluginConsent(manifest),
    contentHash: null,
    isDev: true
  }
}

describe('syntax install and approved lazy loading', () => {
  it('validates install artifacts and exposes metadata without grammar bytes until requested', async () => {
    const plugin = await sample()
    expect(
      await inspectPluginInstallTree({ rootDir: plugin.rootDir, hostVersion: '1.0.0' })
    ).toMatchObject({ ok: true })
    const registry = new PluginSyntaxPackRegistry(new PluginContentVerifier())
    await registry.reconcile([plugin], () => true)
    const metadata = registry.list()[0]!
    expect(metadata.languages).toMatchObject([{ key: 'syntax:community.syntax-sample/sample' }])
    expect(metadata).not.toHaveProperty('grammars')
    expect(metadata.languages[0]).not.toHaveProperty('configuration')
    expect(
      pluginSyntaxPackPayloadSchema.safeParse(
        await registry.load(plugin.pluginKey, metadata.revision)
      ).success
    ).toBe(true)
    expect(await registry.load(plugin.pluginKey, 'wrong-revision')).toBeNull()
  })

  it('checks approval again for list/load without waiting for a refresh', async () => {
    const plugin = await sample()
    let approved = true
    const registry = new PluginSyntaxPackRegistry(new PluginContentVerifier(), () => approved)
    await registry.reconcile([plugin], () => approved)
    const metadata = registry.list()[0]!
    approved = false
    expect(registry.list()).toEqual([])
    expect(await registry.load(plugin.pluginKey, metadata.revision)).toBeNull()
  })

  it.each([
    {
      file: 'sample.json',
      replacement: {
        scopeName: 'source.sample',
        patterns: [{ match: 'changed', name: 'keyword.changed' }]
      }
    },
    { file: 'configuration.json', replacement: { brackets: [['[', ']']] } }
  ])(
    'rejects valid $file edits under an admitted revision and permits exact restoration',
    async ({ file, replacement }) => {
      const plugin = await sample()
      const hash = await hashPluginTree(plugin.rootDir)
      if (!hash.ok) {
        throw new Error(hash.error)
      }
      const installed = { ...plugin, isDev: false, contentHash: hash.hash }
      const registry = new PluginSyntaxPackRegistry(new PluginContentVerifier())
      await registry.reconcile([installed], () => true)
      const revision = registry.list()[0]!.revision
      const path = join(plugin.rootDir, file)
      const original = await readFile(path, 'utf8')
      const admitted = await registry.load(plugin.pluginKey, revision)
      await writeFile(path, JSON.stringify(replacement))
      await expect(registry.load(plugin.pluginKey, revision)).rejects.toThrow('changed')
      await writeFile(path, original)
      expect(await registry.load(plugin.pluginKey, revision)).toEqual(admitted)
    }
  )

  it('refuses installed metadata if artifacts change after the first hash verification', async () => {
    const plugin = await sample()
    const hash = await hashPluginTree(plugin.rootDir)
    if (!hash.ok) {
      throw new Error(hash.error)
    }
    class ChangedAfterVerification extends PluginContentVerifier {
      override async verify(input: Parameters<PluginContentVerifier['verify']>[0]): Promise<void> {
        await super.verify(input)
        await writeFile(
          join(plugin.rootDir, 'sample.json'),
          JSON.stringify({
            scopeName: 'source.sample',
            patterns: []
          })
        )
      }
    }
    const installed = { ...plugin, isDev: false, contentHash: hash.hash }
    const registry = new PluginSyntaxPackRegistry(new ChangedAfterVerification())
    await registry.reconcile([installed], () => true)
    expect(registry.list()).toEqual([])
    expect(registry.error(plugin.pluginKey)).toContain('changed during metadata admission')
  })

  it('requires a new development generation to expose a valid changed grammar', async () => {
    const plugin = await sample()
    const registry = new PluginSyntaxPackRegistry(new PluginContentVerifier())
    await registry.reconcile([plugin], () => true)
    const previous = registry.list()[0]!.revision
    const grammar = {
      scopeName: 'source.sample',
      patterns: [{ match: 'new', name: 'keyword.new' }]
    }
    await writeFile(join(plugin.rootDir, 'sample.json'), JSON.stringify(grammar))
    await expect(registry.load(plugin.pluginKey, previous)).rejects.toThrow('changed')
    await registry.reconcile([plugin], () => true)
    const current = registry.list()[0]!.revision
    expect(current).not.toBe(previous)
    expect(await registry.load(plugin.pluginKey, previous)).toBeNull()
    const payload = await registry.load(plugin.pluginKey, current)
    expect(JSON.parse(payload!.grammars[0]!.content)).toEqual({ ...grammar, repository: {} })
  })

  it('cannot publish a lazy response across removal or approval loss during verification', async () => {
    const plugin = await sample()
    let release = () => {}
    let blocked = false
    class PausedVerifier extends PluginContentVerifier {
      override async verify(): Promise<void> {
        if (blocked) {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
      }
    }
    const registry = new PluginSyntaxPackRegistry(new PausedVerifier())
    await registry.reconcile([plugin], () => true)
    const revision = registry.list()[0]!.revision
    blocked = true
    const pending = registry.load(plugin.pluginKey, revision)
    await registry.reconcile([], () => true)
    release()
    expect(await pending).toBeNull()
    expect(registry.list()).toEqual([])
  })

  it.each([
    { scopeName: 'source.sample', patterns: [{ include: 'source.missing' }] },
    { scopeName: 'source.sample', patterns: [], injectionSelector: 'L:source.*' },
    { scopeName: 'source.other', patterns: [] }
  ])(
    'rejects malformed or external grammar dependencies before installation/activation: %j',
    async (grammar) => {
      const plugin = await sample()
      await writeFile(join(plugin.rootDir, 'sample.json'), JSON.stringify(grammar))
      expect(
        await inspectPluginInstallTree({ rootDir: plugin.rootDir, hostVersion: '1.0.0' })
      ).toMatchObject({ ok: false })
      const registry = new PluginSyntaxPackRegistry(new PluginContentVerifier())
      await registry.reconcile([plugin], () => true)
      expect(registry.list()).toEqual([])
      expect(registry.error(plugin.pluginKey)).toBeTruthy()
    }
  )

  it('rejects grammar paths escaping the package through a symlink', async () => {
    const plugin = await sample()
    const outside = await mkdtemp(join(tmpdir(), 'orca-outside-syntax-'))
    roots.push(outside)
    await writeFile(
      join(outside, 'sample.json'),
      JSON.stringify({ scopeName: 'source.sample', patterns: [] })
    )
    await rm(join(plugin.rootDir, 'sample.json'))
    await symlink(join(outside, 'sample.json'), join(plugin.rootDir, 'sample.json'))
    expect(
      await inspectPluginInstallTree({ rootDir: plugin.rootDir, hostVersion: '1.0.0' })
    ).toMatchObject({ ok: false })
    const registry = new PluginSyntaxPackRegistry(new PluginContentVerifier())
    await registry.reconcile([plugin], () => true)
    expect(registry.list()).toEqual([])
  })
})
