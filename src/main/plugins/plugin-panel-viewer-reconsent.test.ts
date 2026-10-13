import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PluginService } from './plugin-service'
import { listPluginsForClients } from './plugin-client-list'
import type { PluginWorkerFactory } from './plugin-worker-manager'

it('requires opened-file approval when an approved panel package gains a viewer in the same execution class', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-panel-viewer-reconsent-'))
  const manifest = {
    manifestVersion: 2,
    execution: 'sandboxed-ui',
    publisher: 'community',
    id: 'panel',
    name: 'Panel',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: { panels: [{ id: 'panel', title: 'Panel', entry: 'panel.html' }] }
  }
  let approvedFingerprint = ''
  let disabled: string[] = []
  const workerFactory = vi.fn<PluginWorkerFactory>(async () => {
    throw new Error('viewer must not launch a Node worker')
  })
  const service = new PluginService({
    userDataPath: root,
    hostVersion: '1.4.0',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => disabled,
    getPluginConsents: () => ({ 'community.panel': approvedFingerprint }),
    getDevPluginPaths: () => [root],
    workerFactory
  })
  try {
    await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(manifest))
    await writeFile(join(root, 'panel.html'), '<p>Panel</p>')
    await writeFile(
      join(root, 'viewer.js'),
      'throw new Error("approval must never execute this source")'
    )
    await service.initialize()
    approvedFingerprint = service.findValidPlugin('community.panel')!.consentFingerprint
    await service.reconcileActivationState()
    await expect(
      service.panels.open('renderer:1', 'community.panel', 'panel')
    ).resolves.not.toBeNull()

    await writeFile(
      join(root, 'orca-plugin.json'),
      JSON.stringify({
        ...manifest,
        contributes: {
          ...manifest.contributes,
          fileViewers: [
            {
              id: 'file',
              displayName: 'File',
              entry: 'viewer.js',
              selector: [{ filenamePattern: '*.custom' }],
              rendering: 'host-ui',
              mode: 'readonly'
            }
          ]
        }
      })
    )
    await service.refresh()
    expect(service.contentPacks.fileViewers.list()).toEqual([])
    await expect(service.panels.open('renderer:1', 'community.panel', 'panel')).resolves.toBeNull()
    const changed = service.findValidPlugin('community.panel')!
    expect(changed.consentFingerprint).not.toBe(approvedFingerprint)
    await service.reconcileActivationState()
    expect(service.contentPacks.fileViewers.list()).toEqual([])

    approvedFingerprint = changed.consentFingerprint
    await service.reconcileActivationState()
    const [viewer] = service.contentPacks.fileViewers.list()
    if (!viewer) {
      throw new Error('expected approved viewer')
    }
    await expect(
      service.contentPacks.fileViewers.loadSource(viewer.key, viewer.revision, viewer.generation)
    ).resolves.toContain('approval must never execute')
    expect((await listPluginsForClients(service))[0]).toMatchObject({
      fileViewers: [{ id: 'file', displayName: 'File', mode: 'readonly' }]
    })
    disabled = ['community.panel']
    await service.reconcileActivationState()
    expect(service.contentPacks.fileViewers.list()).toEqual([])
    await expect(
      service.contentPacks.fileViewers.loadSource(viewer.key, viewer.revision, viewer.generation)
    ).resolves.toBeNull()
    expect(workerFactory).not.toHaveBeenCalled()
  } finally {
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
