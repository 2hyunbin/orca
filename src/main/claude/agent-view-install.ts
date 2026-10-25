import { dirname, join, posix } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import type { SFTPWrapper } from 'ssh2'
import {
  readHooksJson,
  writeHooksJson,
  writeManagedScript,
  type HooksConfig,
  isPlainObject
} from '../agent-hooks/installer-utils'
import { readHooksJsonWithRaw } from '../agent-hooks/hooks-json-read'
import {
  parseClaudeAgentViewBindings,
  serializeClaudeAgentViewBindings
} from './agent-view-keybindings'
import {
  readHooksJsonRemote,
  readTextFileRemote,
  listRemoteDirectory,
  writeHooksJsonRemote,
  writeManagedScriptRemote
} from '../agent-hooks/installer-utils-remote'
import {
  CLAUDE_AGENT_VIEW_COMMAND,
  CLAUDE_AGENT_VIEW_PLUGIN,
  CLAUDE_AGENT_VIEW_SHORTCUTS,
  normalizeClaudeAgentViewChord
} from '../../shared/claude-agent-view'
import { CLAUDE_AGENT_VIEW_MOD_SOURCE } from './agent-view-mod-source'

export function withClaudeAgentViewShortcut(config: HooksConfig): HooksConfig | null {
  const bindings = config.bindings ?? []
  if (
    !Array.isArray(bindings) ||
    bindings.some((block) => !isPlainObject(block) || !isPlainObject(block.bindings))
  ) {
    return null
  }
  const occupied = new Set<string>()
  for (const block of bindings) {
    for (const [chord, action] of Object.entries(block.bindings)) {
      if (block.context === 'Chat' && action === `command:${CLAUDE_AGENT_VIEW_COMMAND}`) {
        return config
      }
      occupied.add(normalizeClaudeAgentViewChord(chord))
    }
  }
  const shortcut = CLAUDE_AGENT_VIEW_SHORTCUTS.find(
    ({ chord }) =>
      ![...occupied].some(
        (key) =>
          key === normalizeClaudeAgentViewChord(chord) ||
          key.startsWith(`${normalizeClaudeAgentViewChord(chord)} `) ||
          normalizeClaudeAgentViewChord(chord).startsWith(`${key} `)
      )
  )
  return shortcut
    ? {
        ...config,
        bindings: [
          ...bindings,
          {
            context: 'Chat',
            bindings: { [shortcut.chord]: `command:${CLAUDE_AGENT_VIEW_COMMAND}` }
          }
        ]
      }
    : null
}

const manifest = {
  name: CLAUDE_AGENT_VIEW_PLUGIN,
  version: '0.1.0',
  description: 'Open Claude subagents from the Orca sidebar',
  author: { name: 'stablyai' },
  license: 'MIT'
}
const hooks = { modules: ['./register.js'] }
const ownership = { owner: 'stablyai/orca/claude-agent-view' }

export function installClaudeAgentView(configPath: string): void {
  const configDir = dirname(configPath)
  const root = join(configDir, 'skills', CLAUDE_AGENT_VIEW_PLUGIN)
  const marker = join(root, '.claude-plugin', 'orca-managed.json')
  if (existsSync(root) && readHooksJson(marker)?.owner !== ownership.owner) {
    return
  }
  const keybindings = join(configDir, 'keybindings.json')
  const { raw } = readHooksJsonWithRaw(keybindings)
  const config = raw === null ? readHooksJson(keybindings) : parseClaudeAgentViewBindings(raw)
  const next = config && withClaudeAgentViewShortcut(config)
  if (!next) {
    return
  }
  writeHooksJson(marker, ownership)
  writeHooksJson(join(root, '.claude-plugin', 'plugin.json'), manifest)
  writeHooksJson(join(root, 'hooks', 'hooks.json'), hooks)
  writeManagedScript(join(root, 'hooks', 'register.js'), CLAUDE_AGENT_VIEW_MOD_SOURCE)
  writeHooksJson(keybindings, next, { serialized: serializeClaudeAgentViewBindings(raw, next) })
}

export async function installClaudeAgentViewRemote(
  sftp: SFTPWrapper,
  configPath: string
): Promise<void> {
  const configDir = posix.dirname(configPath)
  const root = posix.join(configDir, 'skills', CLAUDE_AGENT_VIEW_PLUGIN)
  const marker = posix.join(root, '.claude-plugin', 'orca-managed.json')
  const existing = await listRemoteDirectory(sftp, root)
  if (existing !== null && (await readHooksJsonRemote(sftp, marker))?.owner !== ownership.owner) {
    return
  }
  const keybindings = posix.join(configDir, 'keybindings.json')
  const raw = await readTextFileRemote(sftp, keybindings)
  const config = parseClaudeAgentViewBindings(raw)
  const next = config && withClaudeAgentViewShortcut(config)
  if (!next) {
    return
  }
  await writeHooksJsonRemote(sftp, marker, ownership)
  await writeHooksJsonRemote(sftp, posix.join(root, '.claude-plugin', 'plugin.json'), manifest)
  await writeHooksJsonRemote(sftp, posix.join(root, 'hooks', 'hooks.json'), hooks)
  await writeManagedScriptRemote(
    sftp,
    posix.join(root, 'hooks', 'register.js'),
    CLAUDE_AGENT_VIEW_MOD_SOURCE
  )
  await writeHooksJsonRemote(sftp, keybindings, next, {
    serialized: serializeClaudeAgentViewBindings(raw, next)
  })
}

export function refreshClaudeAgentView(configPath: string): void {
  const root = join(dirname(configPath), 'skills', CLAUDE_AGENT_VIEW_PLUGIN)
  if (readHooksJson(join(root, '.claude-plugin', 'orca-managed.json'))?.owner === ownership.owner) {
    writeManagedScript(join(root, 'hooks', 'register.js'), CLAUDE_AGENT_VIEW_MOD_SOURCE)
  }
}

export function removeClaudeAgentView(configPath: string): void {
  const configDir = dirname(configPath)
  const root = join(configDir, 'skills', CLAUDE_AGENT_VIEW_PLUGIN)
  if (readHooksJson(join(root, '.claude-plugin', 'orca-managed.json'))?.owner !== ownership.owner) {
    return
  }
  const keybindings = join(configDir, 'keybindings.json')
  const { raw } = readHooksJsonWithRaw(keybindings)
  const config = raw === null ? readHooksJson(keybindings) : parseClaudeAgentViewBindings(raw)
  if (Array.isArray(config?.bindings)) {
    const bindings = config.bindings.map((block) => {
      if (!isPlainObject(block) || !isPlainObject(block.bindings)) {
        return block
      }
      const remaining = Object.fromEntries(
        Object.entries(block.bindings).filter(
          ([, action]) => action !== `command:${CLAUDE_AGENT_VIEW_COMMAND}`
        )
      )
      return { ...block, bindings: remaining }
    })
    const next = { ...config, bindings }
    writeHooksJson(keybindings, next, { serialized: serializeClaudeAgentViewBindings(raw, next) })
  }
  rmSync(root, { recursive: true, force: true })
}
