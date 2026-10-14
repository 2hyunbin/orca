import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverPlugins, isInvalidDiscoveredPlugin } from './plugin-discovery'
import { PLUGIN_CURRENT_POINTER_MAX_BYTES } from './plugin-current-pointer'
import { getPluginActivationState } from '../../shared/plugins/plugin-consent-state'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempPluginsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-discovery-'))
  roots.push(root)
  return root
}

describe('installed plugin discovery identity', () => {
  it.each(['sandboxed-ui', 'trusted-worker'] as const)(
    'withdraws a mutable v2 %s approval when code changes within the same profile',
    async (execution) => {
      const pluginsDir = await tempPluginsDir()
      const devRoot = await tempPluginsDir()
      const entry = execution === 'trusted-worker' ? 'worker.js' : 'panel.html'
      await writeFile(
        join(devRoot, 'orca-plugin.json'),
        JSON.stringify({
          manifestVersion: 2,
          execution,
          id: 'code',
          publisher: 'orca-samples',
          name: 'Code',
          version: '1.0.0',
          engines: { orca: '>=1.0.0' },
          pluginApi: 1,
          ...(execution === 'trusted-worker' ? { main: entry } : {}),
          contributes:
            execution === 'sandboxed-ui'
              ? { panels: [{ id: 'panel', title: 'Panel', entry }] }
              : {},
          capabilities: []
        })
      )
      await writeFile(join(devRoot, entry), 'throw new Error("inert first release")')
      const discover = () =>
        discoverPlugins({ pluginsDir, devPluginPaths: [devRoot], hostVersion: '1.4.0' })
      const [previous] = await discover()
      await writeFile(join(devRoot, entry), 'throw new Error("inert changed release")')
      const [candidate] = await discover()
      if (
        !previous ||
        !candidate ||
        isInvalidDiscoveredPlugin(previous) ||
        isInvalidDiscoveredPlugin(candidate)
      ) {
        throw new Error('Executable fixture did not pass discovery')
      }
      expect(candidate.consentContentHash).not.toBe(previous.consentContentHash)
      expect(candidate.consentFingerprint).not.toBe(previous.consentFingerprint)
      expect(
        getPluginActivationState(candidate.pluginKey, candidate.consentFingerprint, {
          pluginConsents: { [previous.pluginKey]: previous.consentFingerprint },
          disabledPlugins: []
        })
      ).toBe('pending')
    }
  )

  it('keeps the install directory identity when a manifest is invalid or mismatched', async () => {
    const pluginsDir = await tempPluginsDir()
    const installedKey = 'orca-samples.expected'
    const hash = 'a'.repeat(64)
    const versionDir = join(pluginsDir, installedKey, hash)
    await mkdir(versionDir, { recursive: true })
    await writeFile(join(pluginsDir, installedKey, 'current'), hash)
    await writeFile(
      join(versionDir, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 1,
        id: 'different',
        publisher: 'orca-samples',
        name: 'Different',
        version: '1.0.0',
        engines: { orca: '>=1.0.0' },
        pluginApi: 1,
        contributes: { panels: [], commands: [], events: [] },
        capabilities: []
      })
    )

    const [plugin] = await discoverPlugins({ pluginsDir, devPluginPaths: [], hostVersion: '1.4.0' })

    expect(plugin && isInvalidDiscoveredPlugin(plugin)).toBe(true)
    expect(plugin?.pluginKey).toBe(installedKey)
    expect(plugin && 'error' in plugin ? plugin.error : '').toContain('does not match')
  })

  it('keeps a removable qualified identity when the current pointer is missing', async () => {
    const pluginsDir = await tempPluginsDir()
    const installedKey = 'orca-samples.broken'
    await mkdir(join(pluginsDir, installedKey), { recursive: true })

    const [plugin] = await discoverPlugins({ pluginsDir, devPluginPaths: [], hostVersion: '1.4.0' })

    expect(plugin && isInvalidDiscoveredPlugin(plugin)).toBe(true)
    expect(plugin?.pluginKey).toBe(installedKey)
  })

  it('rejects an oversized current pointer without an unbounded startup read', async () => {
    const pluginsDir = await tempPluginsDir()
    const installedKey = 'orca-samples.broken'
    const pluginDir = join(pluginsDir, installedKey)
    await mkdir(pluginDir, { recursive: true })
    const pointer = join(pluginDir, 'current')
    await writeFile(pointer, '')
    await truncate(pointer, PLUGIN_CURRENT_POINTER_MAX_BYTES + 1)

    const [plugin] = await discoverPlugins({ pluginsDir, devPluginPaths: [], hostVersion: '1.4.0' })

    expect(plugin && isInvalidDiscoveredPlugin(plugin)).toBe(true)
    expect(plugin?.pluginKey).toBe(installedKey)
  })
})

describe('instructional plugin discovery identity', () => {
  it('changes dev consent when a VM recipe command changes', async () => {
    const pluginsDir = await tempPluginsDir()
    const devRoot = await tempPluginsDir()
    await mkdir(join(devRoot, 'recipes'))
    await writeFile(
      join(devRoot, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 1,
        id: 'recipes',
        publisher: 'orca-samples',
        name: 'Recipes',
        version: '1.0.0',
        engines: { orca: '>=1.0.0' },
        pluginApi: 1,
        contributes: { vmRecipes: [{ path: 'recipes/cloud.json' }] },
        capabilities: []
      })
    )
    const recipePath = join(devRoot, 'recipes', 'cloud.json')
    await writeFile(
      recipePath,
      JSON.stringify({ schemaVersion: 1, id: 'cloud', name: 'Cloud', create: 'create-v1' })
    )
    const [first] = await discoverPlugins({
      pluginsDir,
      devPluginPaths: [devRoot],
      hostVersion: '1.4.0'
    })
    await writeFile(
      recipePath,
      JSON.stringify({ schemaVersion: 1, id: 'cloud', name: 'Cloud', create: 'create-v2' })
    )
    const [second] = await discoverPlugins({
      pluginsDir,
      devPluginPaths: [devRoot],
      hostVersion: '1.4.0'
    })

    expect(first && !isInvalidDiscoveredPlugin(first)).toBe(true)
    expect(second && !isInvalidDiscoveredPlugin(second)).toBe(true)
    if (
      !first ||
      !second ||
      isInvalidDiscoveredPlugin(first) ||
      isInvalidDiscoveredPlugin(second)
    ) {
      return
    }
    expect(second.consentContentHash).not.toBe(first.consentContentHash)
    expect(second.consentFingerprint).not.toBe(first.consentFingerprint)
  })
})
