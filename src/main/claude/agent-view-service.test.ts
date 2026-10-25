import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeAgentViewService } from './agent-view-service'
import { reconcileClaudeAgentViewConfig } from './agent-view-config'
import { ensureClaudeAgentViewPlugin, ensureClaudeAgentViewPluginAsync } from './agent-view-plugin'
import { claudeAgentViewChord } from './agent-view-keybindings'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('serializes enable/disable for default and profile homes, restoring only shortcuts removed by Orca', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-agent-view-service-'))
  roots.push(root)
  const config = join(root, 'default')
  const profile = join(root, 'account')
  const reconcileConfig = vi.fn(reconcileClaudeAgentViewConfig)
  const ensurePlugin = vi.fn(ensureClaudeAgentViewPluginAsync)
  const service = new ClaudeAgentViewService(join(root, 'orca'), {
    reconcileConfig,
    ensurePlugin,
    listProfiles: async () => [profile],
    loginEnv: async () => ({ CLAUDE_CONFIG_DIR: config })
  })
  const enabled = { claudeSubagentNavigationEnabled: true }
  await Promise.all(Array.from({ length: 100 }, () => service.reconcile(enabled)))
  expect(reconcileConfig).toHaveBeenCalledTimes(2)
  expect(ensurePlugin).toHaveBeenCalledOnce()
  expect(service.read(config)?.pluginDir).toBeTruthy()
  expect(service.read(config)?.pluginDir).toBe(ensureClaudeAgentViewPlugin(join(root, 'orca')))
  await writeFile(join(profile, 'keybindings.json'), '{"bindings":[]}')
  await service.reconcile({ claudeSubagentNavigationEnabled: false })
  expect(service.read(config)).toBeUndefined()
  expect(
    claudeAgentViewChord(await readFile(join(config, 'keybindings.json'), 'utf8'))
  ).toBeUndefined()
  expect(JSON.parse(await readFile(join(config, 'orca-agent-view.json'), 'utf8')).setup).toBe(
    'pending'
  )
  expect(JSON.parse(await readFile(join(profile, 'orca-agent-view.json'), 'utf8')).setup).toBe(
    'attempted'
  )
  await reconcileClaudeAgentViewConfig(join(config, 'settings.json'), false)
  await service.reconcile(enabled)
  expect(claudeAgentViewChord(await readFile(join(config, 'keybindings.json'), 'utf8'))).toBe(
    'ctrl+alt+g'
  )
  expect(await readFile(join(profile, 'keybindings.json'), 'utf8')).toBe('{"bindings":[]}')
  const calls = reconcileConfig.mock.calls.length
  for (let pane = 0; pane < 100; pane++) {
    service.read(config)
  }
  expect(reconcileConfig).toHaveBeenCalledTimes(calls)
  await service.prepareProfile(join(root, 'new-account'))
  expect(
    claudeAgentViewChord(await readFile(join(root, 'new-account', 'keybindings.json'), 'utf8'))
  ).toBe('ctrl+alt+g')
  await service.prepareProfile(join(root, 'new-account'))
  expect(reconcileConfig).toHaveBeenCalledTimes(calls + 1)
})

it.each(['edited', 'reused', 'malformed'] as const)(
  'preserves user bindings through disabling and restart: %s',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-agent-view-disable-'))
    roots.push(root)
    const settings = join(root, 'settings.json')
    const bindings = join(root, 'keybindings.json')
    await reconcileClaudeAgentViewConfig(settings, true)
    const original =
      kind === 'malformed'
        ? '{broken'
        : JSON.stringify({
            bindings: [
              {
                context: 'Chat',
                bindings: {
                  [kind === 'edited' ? 'ctrl+x' : 'ctrl+alt+g']:
                    kind === 'edited' ? 'command:orca-agent-view' : 'command:user'
                }
              }
            ]
          })
    await writeFile(bindings, original)
    await reconcileClaudeAgentViewConfig(settings, false)
    expect(await readFile(bindings, 'utf8')).toBe(original)
    if (kind === 'malformed') {
      await writeFile(
        bindings,
        '{ // repaired\n "bindings": [{"context":"Chat", "bindings":{"ctrl+alt+g":"command:orca-agent-view"}}]}'
      )
      await reconcileClaudeAgentViewConfig(settings, false)
      expect(claudeAgentViewChord(await readFile(bindings, 'utf8'))).toBeUndefined()
    }
    await reconcileClaudeAgentViewConfig(settings, true)
    const restored = await readFile(bindings, 'utf8')
    if (kind === 'malformed') {
      expect(restored).toContain('// repaired')
      expect(claudeAgentViewChord(restored)).toBe('ctrl+alt+g')
    } else {
      expect(restored).toBe(original)
    }
  }
)

it('keeps reconciliation ordered and prevents a stale enable from republishing its plugin root', async () => {
  const config = join(tmpdir(), 'orca-agent-view-ordered-config')
  const userData = join(tmpdir(), 'orca-agent-view-ordered-data')
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reconcileConfig = vi.fn(async () => {
    await gate
  })
  const service = new ClaudeAgentViewService(userData, {
    reconcileConfig,
    ensurePlugin: async () => join(userData, 'plugin'),
    listProfiles: async () => [],
    loginEnv: async () => ({ CLAUDE_CONFIG_DIR: config })
  })
  const first = service.reconcile({ claudeSubagentNavigationEnabled: true })
  await vi.waitFor(() => expect(reconcileConfig).toHaveBeenCalledOnce())
  const second = service.reconcile({ claudeSubagentNavigationEnabled: false })
  expect(service.read(config)).toBeUndefined()
  release()
  await Promise.all([first, second])
  expect(reconcileConfig.mock.calls).toEqual([
    [join(config, 'settings.json'), true],
    [join(config, 'settings.json'), false]
  ])
  expect(service.read(config)).toBeUndefined()
})
