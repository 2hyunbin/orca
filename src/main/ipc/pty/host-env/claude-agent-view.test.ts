import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { applyClaudeAgentViewEnv } from './claude-agent-view'
import type { BuildPtyHostEnvOptions } from './types'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
})

it('requires explicit opt-in, preserves user plugin paths, and respects shortcut deletion', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-claude-pane-env-'))
  roots.push(root)
  const config = join(root, 'profile')
  const options: BuildPtyHostEnvOptions = {
    userDataPath: join(root, 'orca'),
    isPackaged: false,
    selectedCodexHomePath: null,
    agentStatusHooksEnabled: true
  }
  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_PLUGIN_DIRS: `first${delimiter}second`
  }
  applyClaudeAgentViewEnv(env, options)
  expect(existsSync(config)).toBe(false)
  expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBe(`first${delimiter}second`)
  applyClaudeAgentViewEnv(env, { ...options, claudeSubagentNavigationEnabled: true })
  const plugin = env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR
  expect(plugin).toBeTruthy()
  expect(plugin.startsWith(options.userDataPath)).toBe(true)
  expect(existsSync(join(config, 'skills'))).toBe(false)
  expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBe(`first${delimiter}second${delimiter}${plugin}`)
  expect(env.ORCA_CLAUDE_CONFIG_DIR).toBe(config)
  expect(readFileSync(join(plugin, 'hooks', 'register.js'), 'utf8')).toContain('$.ui.view(')
  writeFileSync(join(config, 'keybindings.json'), '{"bindings": []}')
  applyClaudeAgentViewEnv(env, { ...options, claudeSubagentNavigationEnabled: true })
  expect(env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR).toBeUndefined()
  expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBe(`first${delimiter}second`)
  expect(readFileSync(join(config, 'keybindings.json'), 'utf8')).toBe('{"bindings": []}')
})
