import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyPluginLockfile } from '../../shared/plugins/plugin-install-lockfile'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import type { InvalidDiscoveredPlugin, ValidDiscoveredPlugin } from './plugin-discovery'
import { buildPluginList, type PluginListProjectionService } from './plugin-list-projection'
import type { PluginService } from './plugin-service'

const manifest = pluginManifestSchema.parse({
  manifestVersion: 1,
  id: 'demo',
  publisher: 'orca-samples',
  name: 'Demo',
  version: '1.0.0',
  engines: { orca: '>=1.0.0' },
  pluginApi: 1,
  contributes: { panels: [], commands: [], events: [] },
  capabilities: [{ kind: 'workspace:read' }]
})

function serviceWith(
  discovered: ValidDiscoveredPlugin | InvalidDiscoveredPlugin,
  options: {
    activation?: ReturnType<PluginService['activationState']>
    worker?: ReturnType<PluginService['workerState']>
    vmRecipes?: ReturnType<PluginService['contentPacks']['vmRecipes']['preview']>
    commands?: ReturnType<PluginService['contentPacks']['commands']['preview']>
    environmentRecipes?: ReturnType<PluginService['contentPacks']['environmentRecipes']['preview']>
  } = {}
): PluginListProjectionService {
  return {
    options: {
      getPluginConsents: () => ({}),
      getDisabledPlugins: () => []
    },
    getDiscovered: () => [discovered],
    activationState: () => options.activation ?? 'pending',
    workerState: () => options.worker ?? { state: 'inactive', restarts: 0 },
    activationError: () => null,
    isBundledDataPlugin: () => false,
    contentPacks: {
      vmRecipes: { preview: () => options.vmRecipes ?? [] },
      environmentRecipes: { preview: () => options.environmentRecipes ?? [] },
      commands: { preview: () => options.commands ?? [] }
    }
  }
}

describe('buildPluginList consent identity', () => {
  it('projects the exact current fingerprint for an optimistic consent write', async () => {
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'orca-samples.demo',
      rootDir: join(tmpdir(), 'plugins', 'demo'),
      manifest,
      consentFingerprint: 'sha256-current',
      contentHash: null,
      isDev: true
    }

    expect((await buildPluginList(serviceWith(plugin), emptyPluginLockfile()))[0]).toMatchObject({
      pluginKey: plugin.pluginKey,
      consentFingerprint: 'sha256-current',
      status: 'pending'
    })
  })

  it('projects supervised backoff as restarting instead of running', async () => {
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'orca-samples.demo',
      rootDir: join(tmpdir(), 'plugins', 'demo'),
      manifest,
      consentFingerprint: 'sha256-current',
      contentHash: null,
      isDev: true
    }

    expect(
      (
        await buildPluginList(
          serviceWith(plugin, {
            activation: 'approved',
            worker: { state: 'restarting', restarts: 2 }
          }),
          emptyPluginLockfile()
        )
      )[0]
    ).toMatchObject({ status: 'restarting', restarts: 2 })
  })

  it('does not attribute a shadowing dev plugin to the installed source', async () => {
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'orca-samples.demo',
      rootDir: join(tmpdir(), 'development', 'demo'),
      manifest,
      consentFingerprint: 'sha256-current',
      contentHash: null,
      isDev: true
    }
    const lock = {
      version: 1 as const,
      plugins: {
        [plugin.pluginKey]: {
          pluginKey: plugin.pluginKey,
          version: '1.0.0',
          source: { kind: 'git' as const, url: 'https://example.com/demo.git', ref: 'v1' },
          resolvedCommit: 'a'.repeat(40),
          contentHash: 'b'.repeat(64),
          consentFingerprint: 'sha256-installed',
          installedAt: 1
        }
      }
    }

    expect((await buildPluginList(serviceWith(plugin), lock))[0]).not.toHaveProperty('source')
  })

  it('does not expose an invalid development plugin absolute path as identity', async () => {
    const invalid: InvalidDiscoveredPlugin = {
      rootDir: join(tmpdir(), 'private', 'secret-plugin-path'),
      error: 'missing orca-plugin.json',
      isDev: true
    }
    const service = serviceWith(invalid)

    const projected = (await buildPluginList(service, emptyPluginLockfile()))[0]!
    expect(projected.pluginKey).toBe('invalid-development-plugin-1')
    expect(projected.name).toBe('invalid-development-plugin-1')
    expect(JSON.stringify(projected)).not.toContain(invalid.rootDir)
  })

  it('projects exact VM lifecycle commands for instructional consent', async () => {
    const recipeManifest = pluginManifestSchema.parse({
      ...manifest,
      contributes: { vmRecipes: [{ path: 'recipes/cloud.json' }] }
    })
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'orca-samples.demo',
      rootDir: join(tmpdir(), 'plugins', 'demo'),
      manifest: recipeManifest,
      consentFingerprint: 'sha256-current',
      consentContentHash: 'a'.repeat(64),
      contentHash: null,
      isDev: true
    }

    expect(
      (
        await buildPluginList(
          serviceWith(plugin, {
            vmRecipes: [
              {
                pluginKey: plugin.pluginKey,
                recipe: {
                  id: 'cloud',
                  name: 'Cloud',
                  create: './create.sh',
                  destroyDisabled: true
                }
              }
            ]
          }),
          emptyPluginLockfile()
        )
      )[0]?.vmRecipes
    ).toEqual([
      {
        id: 'cloud',
        name: 'Cloud',
        commands: [
          { phase: 'create', command: './create.sh' },
          { phase: 'destroy', command: 'none' }
        ]
      }
    ])
  })

  it('projects command handlers and normalized keybindings for consent and dispatch', async () => {
    const commandManifest = pluginManifestSchema.parse({
      ...manifest,
      contributes: {
        commands: [{ id: 'tasks', title: 'Open Tasks', context: 'worktree', action: 'view.tasks' }],
        keybindings: [{ command: 'tasks', key: 'mod+alt+t' }]
      }
    })
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'orca-samples.demo',
      rootDir: join(tmpdir(), 'plugins', 'demo'),
      manifest: commandManifest,
      consentFingerprint: 'sha256-current',
      consentContentHash: 'a'.repeat(64),
      contentHash: null,
      isDev: true
    }

    expect(
      (
        await buildPluginList(
          serviceWith(plugin, {
            commands: [
              {
                pluginKey: plugin.pluginKey,
                id: 'tasks',
                title: 'Open Tasks',
                context: 'worktree',
                handler: { type: 'built-in', action: 'view.tasks' },
                keybindings: [{ key: 'Mod+Alt+T', when: 'worktree' }]
              }
            ]
          }),
          emptyPluginLockfile()
        )
      )[0]?.commands
    ).toEqual([
      {
        id: 'tasks',
        title: 'Open Tasks',
        context: 'worktree',
        handler: { type: 'built-in', action: 'view.tasks' },
        keybindings: [{ key: 'Mod+Alt+T', when: 'worktree' }]
      }
    ])
  })
  it('projects executable provider identity and exact literal commands for review', async () => {
    const envManifest = pluginManifestSchema.parse({
      ...manifest,
      manifestVersion: 2,
      execution: 'instructional',
      capabilities: [],
      contributes: { environmentRecipes: [{ path: 'recipes/pods.json' }] }
    })
    const p: ValidDiscoveredPlugin = {
      pluginKey: 'orca-samples.demo',
      rootDir: join(tmpdir(), 'provider'),
      manifest: envManifest,
      consentFingerprint: 'sha256-reviewed',
      contentHash: null,
      isDev: true
    }
    const recipe = {
      schemaVersion: 1,
      id: 'pods',
      name: 'Development pods',
      description: 'Company machines',
      lifetime: 'both',
      createFields: [],
      commands: {
        list: { program: 'company-dev', args: ['list', ';literal'], timeoutSeconds: 120 }
      }
    } as const
    const entries = await buildPluginList(
      serviceWith(p, {
        environmentRecipes: [
          {
            pluginKey: p.pluginKey,
            recipe: {
              ...recipe,
              commands: { list: { ...recipe.commands.list, args: [...recipe.commands.list.args] } },
              createFields: []
            }
          }
        ]
      }),
      emptyPluginLockfile()
    )
    expect(entries[0]).toMatchObject({
      execution: 'instructional',
      environmentRecipeCount: 1,
      environmentRecipes: [
        {
          providerId: 'orca-samples.demo/pods',
          commands: [{ action: 'list', program: 'company-dev', args: ['list', ';literal'] }]
        }
      ]
    })
    const unavailable = await buildPluginList(serviceWith(p), emptyPluginLockfile())
    expect(unavailable[0]).toMatchObject({
      execution: 'instructional',
      environmentRecipeCount: 1,
      environmentRecipes: []
    })
  })
})
