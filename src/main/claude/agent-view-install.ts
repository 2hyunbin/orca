import { dirname, join, posix } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import type { SFTPWrapper } from 'ssh2'
import {
  readHooksJson,
  writeHooksJson,
  writeHooksJsonAsync,
  writeManagedScript,
  type HooksConfig,
  isPlainObject
} from '../agent-hooks/installer-utils'
import { parseHooksJsonText, readHooksJsonWithRaw } from '../agent-hooks/hooks-json-read'
import {
  claudeAgentViewChord,
  parseClaudeAgentViewBindings,
  serializeClaudeAgentViewBindings
} from './agent-view-keybindings'
import {
  readHooksJsonRemote,
  readTextFileRemote,
  writeHooksJsonRemote,
  renamePlain
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

const ownership = { owner: 'stablyai/orca/claude-agent-view' }
const markerName = 'orca-agent-view.json'

export const CLAUDE_AGENT_VIEW_PLUGIN_FILES: Record<string, string> = {
  '.claude-plugin/plugin.json': JSON.stringify({
    name: CLAUDE_AGENT_VIEW_PLUGIN,
    version: '0.2.0',
    description: 'Open Claude subagents from the Orca sidebar',
    author: { name: 'stablyai' },
    license: 'MIT'
  }),
  'hooks/hooks.json': JSON.stringify({ modules: ['./register.js'] }),
  'hooks/register.js': CLAUDE_AGENT_VIEW_MOD_SOURCE
}

export function ensureClaudeAgentViewPlugin(
  userDataPath: string,
  source = CLAUDE_AGENT_VIEW_MOD_SOURCE
): string {
  const files = { ...CLAUDE_AGENT_VIEW_PLUGIN_FILES, 'hooks/register.js': source }
  const version = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 20)
  const root = join(userDataPath, 'claude-agent-view', version, CLAUDE_AGENT_VIEW_PLUGIN)
  for (const [path, content] of Object.entries(files)) {
    writeManagedScript(join(root, path), content)
  }
  return root
}

function shortcutOwnership(config: HooksConfig, next: HooksConfig): HooksConfig {
  const block = config !== next && Array.isArray(next.bindings) ? next.bindings.at(-1) : undefined
  const chord =
    isPlainObject(block) && isPlainObject(block.bindings)
      ? Object.keys(block.bindings)[0]
      : undefined
  return {
    ...ownership,
    setup: 'attempted',
    ...(chord ? { binding: { context: 'Chat', chord } } : {})
  }
}

// Called only after the user opts in; a surviving marker remembers deletions and edited chords.
export function installClaudeAgentView(configPath: string): boolean {
  const configDir = dirname(configPath)
  const keybindings = join(configDir, 'keybindings.json')
  const { raw } = readHooksJsonWithRaw(keybindings)
  const config = raw === null ? readHooksJson(keybindings) : parseClaudeAgentViewBindings(raw)
  if (!config) {
    return false
  }
  const marker = join(configDir, markerName)
  const legacyRoot = join(configDir, 'skills', CLAUDE_AGENT_VIEW_PLUGIN)
  const legacy = readHooksJson(join(legacyRoot, '.claude-plugin', 'orca-managed.json'))
  if (legacy?.owner === ownership.owner) {
    writeHooksJson(marker, { ...legacy, setup: 'attempted' })
    rmSync(legacyRoot, { recursive: true, force: true })
    return claudeAgentViewChord(raw ?? '') !== undefined
  }
  const previous = readHooksJson(marker)
  if (existsSync(marker) && (previous?.owner !== ownership.owner || previous.setup !== 'pending')) {
    return claudeAgentViewChord(raw ?? '') !== undefined
  }
  const next = withClaudeAgentViewShortcut(config)
  if (!next) {
    return false
  }
  writeHooksJson(marker, shortcutOwnership(config, next))
  writeHooksJson(keybindings, next, { serialized: serializeClaudeAgentViewBindings(raw, next) })
  return claudeAgentViewChord(serializeClaudeAgentViewBindings(raw, next)) !== undefined
}

function withoutOwnedBinding(config: HooksConfig, marker: HooksConfig): HooksConfig {
  const binding = isPlainObject(marker.binding) ? marker.binding : undefined
  if (marker.owner !== ownership.owner || !binding || !Array.isArray(config.bindings)) {
    return config
  }
  return {
    ...config,
    bindings: config.bindings.flatMap((block) => {
      if (!isPlainObject(block) || !isPlainObject(block.bindings)) {
        return [block]
      }
      const remaining = Object.fromEntries(
        Object.entries(block.bindings).filter(
          ([chord, action]) =>
            block.context !== binding.context ||
            chord !== binding.chord ||
            action !== `command:${CLAUDE_AGENT_VIEW_COMMAND}`
        )
      )
      if (Object.keys(remaining).length === Object.keys(block.bindings).length) {
        return [block]
      }
      return Object.keys(remaining).length === 0 &&
        Object.keys(block).every((key) => key === 'context' || key === 'bindings')
        ? []
        : [{ ...block, bindings: remaining }]
    })
  }
}

export function removeClaudeAgentView(configPath: string): void {
  const configDir = dirname(configPath)
  const root = join(configDir, 'skills', CLAUDE_AGENT_VIEW_PLUGIN)
  const legacy = readHooksJson(join(root, '.claude-plugin', 'orca-managed.json'))
  const markerPath = join(configDir, markerName)
  const marker = readHooksJson(markerPath)
  const keybindings = join(configDir, 'keybindings.json')
  const { raw } = readHooksJsonWithRaw(keybindings)
  const original = raw === null ? readHooksJson(keybindings) : parseClaudeAgentViewBindings(raw)
  let config = original
  for (const owned of [legacy, marker]) {
    if (config && owned?.owner === ownership.owner) {
      config = withoutOwnedBinding(config, owned)
    }
  }
  if (config && JSON.stringify(original) !== JSON.stringify(config)) {
    writeHooksJson(keybindings, config, {
      serialized: serializeClaudeAgentViewBindings(raw, config)
    })
  }
  if (marker?.owner === ownership.owner && !config) {
    writeHooksJson(markerPath, { ...marker, cleanupPending: true })
  }
  if (legacy?.owner === ownership.owner) {
    writeHooksJson(markerPath, { ...legacy, setup: 'attempted', cleanupPending: !config })
    rmSync(root, { recursive: true, force: true })
  }
}

function retirementMarker(
  previous: HooksConfig | null,
  legacy: HooksConfig,
  config: HooksConfig | null
): HooksConfig {
  const removed = config && withoutOwnedBinding(config, legacy)
  return {
    ...(previous?.owner === ownership.owner
      ? previous
      : {
          ...legacy,
          setup:
            config && JSON.stringify(config) !== JSON.stringify(removed) ? 'pending' : 'attempted'
        }),
    cleanupPending: !config
  }
}

export async function refreshClaudeAgentView(configPath: string): Promise<void> {
  const configDir = dirname(configPath)
  const root = join(configDir, 'skills', CLAUDE_AGENT_VIEW_PLUGIN)
  const legacy = parseHooksJsonText(
    await readFile(join(root, '.claude-plugin', 'orca-managed.json'), 'utf8').catch(() => '{}')
  )
  const markerPath = join(configDir, markerName)
  const previous = parseHooksJsonText(await readFile(markerPath, 'utf8').catch(() => '{}'))
  const marker =
    legacy?.owner === ownership.owner ? legacy : previous?.cleanupPending === true ? previous : null
  if (marker?.owner !== ownership.owner) {
    return
  }
  const keybindings = join(configDir, 'keybindings.json')
  const raw = await readFile(keybindings, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    console.warn('[agent-hooks] Claude agent view binding cleanup deferred', error)
    return undefined
  })
  const config = raw === undefined ? null : parseClaudeAgentViewBindings(raw)
  await writeHooksJsonAsync(markerPath, retirementMarker(previous, marker, config))
  if (config && raw !== undefined) {
    const next = withoutOwnedBinding(config, marker)
    if (JSON.stringify(config) !== JSON.stringify(next)) {
      await writeHooksJsonAsync(keybindings, next, {
        serialized: serializeClaudeAgentViewBindings(raw, next)
      })
    }
  }
  if (legacy?.owner === ownership.owner) {
    await rm(root, { recursive: true, force: true })
  }
}

export async function removeClaudeAgentViewRemote(
  sftp: SFTPWrapper,
  configPath: string
): Promise<void> {
  const configDir = posix.dirname(configPath)
  const root = posix.join(configDir, 'skills', CLAUDE_AGENT_VIEW_PLUGIN)
  const legacy = await readHooksJsonRemote(
    sftp,
    posix.join(root, '.claude-plugin', 'orca-managed.json')
  )
  const markerPath = posix.join(configDir, markerName)
  const previous = await readHooksJsonRemote(sftp, markerPath)
  const marker =
    legacy?.owner === ownership.owner ? legacy : previous?.cleanupPending === true ? previous : null
  if (marker?.owner !== ownership.owner) {
    return
  }
  const keybindings = posix.join(configDir, 'keybindings.json')
  const raw = await readTextFileRemote(sftp, keybindings).catch((error: unknown) => {
    console.warn('[agent-hooks] Remote Claude agent view binding cleanup deferred', error)
    return undefined
  })
  const config = raw === undefined ? null : parseClaudeAgentViewBindings(raw)
  await writeHooksJsonRemote(sftp, markerPath, retirementMarker(previous, marker, config))
  if (config && raw !== undefined) {
    const next = withoutOwnedBinding(config, marker)
    if (JSON.stringify(config) !== JSON.stringify(next)) {
      await writeHooksJsonRemote(sftp, keybindings, next, {
        serialized: serializeClaudeAgentViewBindings(raw, next)
      })
    }
  }
  if (legacy?.owner === ownership.owner) {
    await renamePlain(sftp, root, posix.join(configDir, `orca-agent-view-retired-${randomUUID()}`))
  }
}
