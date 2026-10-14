import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginLockfile } from '../../shared/plugins/plugin-install-lockfile'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import type { ValidDiscoveredPlugin } from '../plugins/plugin-discovery'
import { PluginService } from '../plugins/plugin-service'
import { Store } from '../persistence'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electronMocks = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: electronMocks.handle, on: electronMocks.on }
}))

import {
  canRemoveInstalledPlugin,
  parsePluginConsentArgs,
  parsePluginInstallArgs,
  registerPluginHandlers
} from './plugins'

beforeEach(() => {
  electronMocks.handle.mockReset()
  electronMocks.on.mockReset()
})

describe('plugin consent IPC schema', () => {
  it('requires the fingerprint reviewed by the caller', () => {
    expect(() =>
      parsePluginConsentArgs({ pluginKey: 'orca-samples.demo', decision: 'approve' })
    ).toThrow()
  })

  it('accepts an explicit reviewed fingerprint', () => {
    expect(
      parsePluginConsentArgs({
        pluginKey: 'orca-samples.demo',
        reviewedFingerprint: 'sha256-reviewed',
        decision: 'approve'
      })
    ).toEqual({
      pluginKey: 'orca-samples.demo',
      reviewedFingerprint: 'sha256-reviewed',
      decision: 'approve'
    })
  })
})

describe('plugin install IPC schema', () => {
  it('requires a non-empty git ref', () => {
    expect(() =>
      parsePluginInstallArgs({ kind: 'git', url: 'https://example.com/plugin.git' })
    ).toThrow()
    expect(() =>
      parsePluginInstallArgs({ kind: 'git', url: 'https://example.com/plugin.git', ref: '   ' })
    ).toThrow()
  })

  it('accepts an explicit git ref', () => {
    expect(
      parsePluginInstallArgs({
        kind: 'git',
        url: 'https://example.com/plugin.git',
        ref: ' v1.2.3 '
      })
    ).toEqual({ kind: 'git', url: 'https://example.com/plugin.git', ref: 'v1.2.3' })
  })

  it('accepts HTTPS and SSH git transports', () => {
    expect(
      parsePluginInstallArgs({
        kind: 'git',
        url: 'ssh://git@example.com/acme/plugin.git',
        ref: 'main'
      })
    ).toEqual({
      kind: 'git',
      url: 'ssh://git@example.com/acme/plugin.git',
      ref: 'main'
    })
    expect(
      parsePluginInstallArgs({
        kind: 'git',
        url: 'git@example.com:acme/plugin.git',
        ref: 'main'
      })
    ).toEqual({ kind: 'git', url: 'git@example.com:acme/plugin.git', ref: 'main' })
  })

  it('rejects executable helpers and embedded HTTPS credentials', () => {
    expect(() =>
      parsePluginInstallArgs({ kind: 'git', url: 'ext::sh -c calc', ref: 'main' })
    ).toThrow()
    expect(() =>
      parsePluginInstallArgs({
        kind: 'git',
        url: 'https://user@example.com/plugin.git',
        ref: 'main'
      })
    ).toThrow()
  })
})

function removalPlugin(pluginKey: string, isDev = false): ValidDiscoveredPlugin {
  const [publisher, id] = pluginKey.split('.')
  return {
    pluginKey,
    isDev,
    rootDir: 'fixture',
    contentHash: null,
    consentFingerprint: 'fixture-reviewed',
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      publisher,
      id,
      name: id,
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: {},
      capabilities: []
    })
  }
}

describe('plugin removal authority', () => {
  it('refuses app-owned data even without a user-data installation lock', () => {
    const service: Pick<PluginService, 'getDiscovered' | 'isBundledDataPlugin'> = {
      getDiscovered: () => [removalPlugin('stablyai.orca-locale-es')],
      isBundledDataPlugin: () => true
    }
    expect(canRemoveInstalledPlugin(service, 'stablyai.orca-locale-es')).toBe(false)
  })

  it('allows installed rows but refuses dev overrides and unknown keys', () => {
    const service: Pick<PluginService, 'getDiscovered' | 'isBundledDataPlugin'> = {
      isBundledDataPlugin: () => false,
      getDiscovered: () => [
        removalPlugin('orca-samples.installed'),
        removalPlugin('orca-samples.dev', true)
      ]
    }

    expect(canRemoveInstalledPlugin(service, 'orca-samples.installed')).toBe(true)
    expect(canRemoveInstalledPlugin(service, 'orca-samples.dev')).toBe(false)
    expect(canRemoveInstalledPlugin(service, 'orca-samples.unknown')).toBe(false)
  })

  it('refuses bundled installs because startup would restore them', () => {
    const service: Pick<PluginService, 'getDiscovered' | 'isBundledDataPlugin'> = {
      isBundledDataPlugin: () => false,
      getDiscovered: () => [removalPlugin('stablyai.orca-theme')]
    }
    const lock = {
      version: 1,
      plugins: {
        'stablyai.orca-theme': {
          pluginKey: 'stablyai.orca-theme',
          version: '1.0.0',
          source: { kind: 'bundled', bundleId: 'stablyai.orca-theme' },
          resolvedCommit: null,
          contentHash: 'a'.repeat(64),
          consentFingerprint: 'reviewed',
          installedAt: 1
        }
      }
    } satisfies PluginLockfile

    expect(canRemoveInstalledPlugin(service, 'stablyai.orca-theme', lock)).toBe(false)
  })
})

describe('plugin settings lifecycle authority', () => {
  it('refreshes from the main-process settings listener without renderer follow-up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-settings-'))
    const store = new Store({
      dataFile: join(root, 'profile.json'),
      serializedState: JSON.stringify({ settings: { pluginSystemEnabled: true } })
    })
    const service = new PluginService({
      userDataPath: root,
      hostVersion: '1.4.0',
      isPluginSystemEnabled: () => store.getSettings().pluginSystemEnabled,
      getDevPluginPaths: () => [],
      getDisabledPlugins: () => [],
      getPluginConsents: () => ({})
    })
    const refresh = vi.spyOn(service, 'refresh').mockResolvedValue(undefined)
    try {
      registerPluginHandlers(store, service, null)
      store.updateSettings({ pluginSystemEnabled: false }, { notifyListeners: true })
      expect(refresh).toHaveBeenCalledOnce()
    } finally {
      await service.dispose()
      await store.freezeWritesAsync()
      await rm(root, { recursive: true, force: true })
    }
  })
})
