import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginService } from './plugin-service'
import { installStagedPluginTree } from './plugin-install-staging'
import { hashPluginTree } from './plugin-content-hash'
import { readPluginCurrentPointer } from './plugin-current-pointer'

const syntaxKey = 'stablyai.orca-syntax-typst'
const bundledRoot = join(process.cwd(), 'resources', 'plugins', 'launch')
const roots: string[] = []
const services: PluginService[] = []
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-bundled-fallback-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('approved optional recovery when shipped data is unavailable', () => {
  it.each(['missing', 'tampered', 'executable'] as const)(
    'uses an approved official pin with a %s snapshot and preserves it through disable/restart',
    async (damage) => {
      const userDataPath = await scratch()
      const root = await scratch()
      const source = await scratch()
      await cp(join(bundledRoot, syntaxKey), source, { recursive: true })
      const installed = await installStagedPluginTree({
        pluginsDir: join(userDataPath, 'plugins'),
        stagingDir: source,
        hostVersion: '1.4.214',
        source: {
          kind: 'git',
          url: 'https://github.com/stablyai/orca-plugin-syntax-typst.git',
          ref: 'v1.0.0'
        },
        resolvedCommit: 'a'.repeat(40)
      })
      if (!installed.ok) {
        throw new Error(installed.error)
      }
      if (damage !== 'missing') {
        const snapshotRoot = join(root, syntaxKey)
        await cp(join(bundledRoot, syntaxKey), snapshotRoot, { recursive: true })
        const manifestPath = join(snapshotRoot, 'orca-plugin.json')
        if (damage === 'executable') {
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
          manifest.execution = 'trusted-worker'
          manifest.main = 'worker.js'
          await writeFile(manifestPath, JSON.stringify(manifest))
          await writeFile(join(snapshotRoot, 'worker.js'), 'throw new Error("must not execute")')
        }
        const hashed = await hashPluginTree(snapshotRoot)
        if (!hashed.ok) {
          throw new Error(hashed.error)
        }
        await writeFile(
          join(root, 'bundled-plugins.json'),
          JSON.stringify({
            version: 1,
            plugins: [
              {
                pluginKey: syntaxKey,
                path: syntaxKey,
                contentHash: hashed.hash,
                activation: 'bundled-data'
              }
            ]
          })
        )
        if (damage === 'tampered') {
          await writeFile(join(snapshotRoot, 'README.md'), 'changed after the indexed release')
        }
      }
      let enabled = true
      let disabled: string[] = []
      let approved = true
      const createService = () => {
        const service = new PluginService({
          userDataPath,
          bundledPluginsRoot: root,
          hostVersion: '1.4.214',
          isPluginSystemEnabled: () => enabled,
          getDisabledPlugins: () => [],
          getDisabledBundledDataPlugins: () => disabled,
          getPluginConsents: (): Record<string, string> =>
            approved ? { [syntaxKey]: installed.consentFingerprint } : {},
          getDevPluginPaths: () => []
        })
        services.push(service)
        return service
      }
      let service = createService()
      await service.initialize()
      const assertInstalled = () => {
        expect(service.contentPacks.syntaxPacks.list()).toEqual([
          expect.objectContaining({
            revision: installed.contentHash,
            languages: [expect.objectContaining({ builtInLanguage: 'typst' })]
          })
        ])
        expect(
          service.listBundledData().find((pack) => pack.pluginKey === syntaxKey)
        ).toMatchObject({
          source: 'installed',
          enabled: true,
          unavailable: false,
          bundledVersion: null
        })
      }
      assertInstalled()
      approved = false
      await service.reconcileActivationState()
      expect(service.contentPacks.syntaxPacks.list()).toEqual([])
      approved = true
      disabled = [syntaxKey]
      await service.reconcileActivationState()
      expect(service.contentPacks.syntaxPacks.list()).toEqual([])
      disabled = []
      enabled = false
      await service.refresh()
      expect(service.contentPacks.syntaxPacks.list()).toEqual([])
      expect(service.listBundledData().find((pack) => pack.pluginKey === syntaxKey)).toMatchObject({
        source: 'unavailable',
        enabled: true,
        unavailable: true
      })
      await service.dispose()
      enabled = true
      service = createService()
      await service.initialize()
      assertInstalled()
      expect(await readPluginCurrentPointer(join(userDataPath, 'plugins', syntaxKey))).toBe(
        installed.contentHash
      )
    }
  )
})
