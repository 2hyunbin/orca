import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createPluginLocaleEnvelope } from '../../shared/plugins/plugin-locale-envelope'
import { getPluginLocaleKit } from './plugin-locale-source'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import type { PluginWorkerFactory } from './plugin-worker-manager'
import { PluginService } from './plugin-service'

const roots: string[] = []
const services: PluginService[] = []
const pluginKey = 'community.locale-de'

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each([
  { execution: 'panel', manifestVersion: 1 },
  { execution: 'worker', manifestVersion: 1 },
  { execution: 'panel', manifestVersion: 2 },
  { execution: 'viewer', manifestVersion: 2 },
  { execution: 'worker', manifestVersion: 2 }
] as const)(
  'blocks a v$manifestVersion language pack gaining a $execution until reviewed',
  async ({ execution, manifestVersion }) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-data-reconsent-'))
    roots.push(root)
    const dataManifest = pluginManifestSchema.parse({
      manifestVersion,
      ...(manifestVersion === 2 ? { execution: 'data' } : {}),
      publisher: 'community',
      id: 'locale-de',
      name: 'German',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: { languagePacks: [{ locale: 'de', path: 'de.json' }] }
    })
    await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(dataManifest))
    const catalog =
      manifestVersion === 2
        ? createPluginLocaleEnvelope({
            kit: await getPluginLocaleKit(),
            locale: 'de',
            displayName: 'Deutsch',
            translations: { 'menu.file': 'Datei' }
          })
        : { greeting: 'Hallo' }
    await writeFile(join(root, 'de.json'), JSON.stringify(catalog))
    await writeFile(join(root, 'panel.html'), '<script>window.executed = true</script>')
    await writeFile(join(root, 'worker.js'), 'export default async function () {}')
    let approvedFingerprint = fingerprintPluginConsent(dataManifest)
    const workerFactory = vi.fn<PluginWorkerFactory>(async () => ({
      commands: ['run'],
      invokeCommand: vi.fn(async () => 'approved'),
      deliverEvent: vi.fn(),
      lastActivityAt: () => Date.now(),
      inFlightCount: () => 0,
      dispose: vi.fn(async () => undefined),
      kill: vi.fn(),
      onExit: vi.fn()
    }))
    const service = new PluginService({
      userDataPath: root,
      hostVersion: '1.4.0',
      isPluginSystemEnabled: () => true,
      getDisabledPlugins: () => [],
      getPluginConsents: () => ({ [pluginKey]: approvedFingerprint }),
      getDevPluginPaths: () => [root],
      workerFactory
    })
    services.push(service)
    await service.initialize()
    if (manifestVersion === 2) {
      expect(service.contentPacks.languagePacks.list()).toHaveLength(0)
      approvedFingerprint = service.findValidPlugin(pluginKey)!.consentFingerprint
      await service.reconcileActivationState()
    }
    expect(service.contentPacks.languagePacks.list()).toHaveLength(1)
    expect(workerFactory).not.toHaveBeenCalled()

    const changedManifest = pluginManifestSchema.parse({
      ...dataManifest,
      ...(manifestVersion === 2
        ? { execution: execution === 'worker' ? 'trusted-worker' : 'sandboxed-ui' }
        : {}),
      ...(execution === 'worker' ? { main: 'worker.js' } : {}),
      contributes: {
        ...dataManifest.contributes,
        ...(execution === 'panel'
          ? { panels: [{ id: 'panel', title: 'Panel', entry: 'panel.html' }] }
          : execution === 'viewer'
            ? {
                fileViewers: [
                  {
                    id: 'file',
                    displayName: 'File',
                    selector: [{ filenamePattern: '*.custom' }],
                    entry: 'worker.js',
                    rendering: 'host-ui',
                    mode: 'readonly'
                  }
                ]
              }
            : { commands: [{ id: 'run', title: 'Run' }] })
      }
    })
    expect(changedManifest.capabilities).toEqual(dataManifest.capabilities)
    await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(changedManifest))
    await service.refresh()

    expect(service.contentPacks.languagePacks.list()).toHaveLength(0)
    expect(service.contentPacks.fileViewers.list()).toHaveLength(0)
    await expect(service.panels.open('renderer:1', pluginKey, 'panel')).resolves.toBeNull()
    await expect(service.invokeCommand(pluginKey, 'run')).rejects.toThrow('is not enabled')
    expect(workerFactory).not.toHaveBeenCalled()

    await service.reconcileActivationState()
    expect(workerFactory).not.toHaveBeenCalled()
    await expect(service.panels.open('renderer:1', pluginKey, 'panel')).resolves.toBeNull()

    approvedFingerprint = service.findValidPlugin(pluginKey)!.consentFingerprint
    await service.reconcileActivationState()
    expect(service.contentPacks.languagePacks.list()).toHaveLength(1)
    if (execution === 'panel') {
      await expect(service.panels.open('renderer:1', pluginKey, 'panel')).resolves.toMatchObject({
        html: expect.stringContaining('window.executed'),
        sessionToken: expect.any(String)
      })
      expect(workerFactory).not.toHaveBeenCalled()
    } else if (execution === 'worker') {
      await expect(service.invokeCommand(pluginKey, 'run')).resolves.toBe('approved')
      expect(workerFactory).toHaveBeenCalledOnce()
    } else {
      const viewer = service.contentPacks.fileViewers.list()[0]
      expect(viewer).toMatchObject({ pluginKey, mode: 'readonly', rendering: 'host-ui' })
      if (!viewer) {
        throw new Error('expected approved viewer')
      }
      await expect(
        service.contentPacks.fileViewers.loadSource(viewer.key, viewer.revision, viewer.generation)
      ).resolves.toContain('export default')
      expect(workerFactory).not.toHaveBeenCalled()
    }
  }
)
