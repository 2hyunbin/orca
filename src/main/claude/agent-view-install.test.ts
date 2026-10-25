import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parse } from 'jsonc-parser'
import { claudeAgentViewChord } from './agent-view-keybindings'
import { createAgentHookMemorySftp } from '../agent-hooks/agent-hook-memory-sftp.test-fixture'
import {
  installClaudeAgentView,
  installClaudeAgentViewRemote,
  withClaudeAgentViewShortcut,
  removeClaudeAgentView
} from './agent-view-install'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

it('installs on the remote host and refuses a remote folder with no ownership marker', async () => {
  const config = '/home/remote/.claude/settings.json'
  const root = '/home/remote/.claude/skills/orca-agent-view'
  const memory = createAgentHookMemorySftp({ [config]: '{"enabledPlugins":{"user@market":true}}' })
  memory.fs.dirs.add(root)
  memory.fs.files.set(`${root}/SKILL.md`, 'user-owned')
  const before = [...memory.fs.files]
  await installClaudeAgentViewRemote(memory.sftp, config)
  expect([...memory.fs.files]).toEqual(before)
  memory.fs.dirs.delete(root)
  memory.fs.files.delete(`${root}/SKILL.md`)
  await installClaudeAgentViewRemote(memory.sftp, config)
  expect(memory.fs.files.get(config)).toBe('{"enabledPlugins":{"user@market":true}}')
  expect(memory.fs.files.get(`${root}/hooks/register.js`)).toContain('$.ui.view(')
  expect(
    claudeAgentViewChord(memory.fs.files.get('/home/remote/.claude/keybindings.json') ?? '')
  ).toBe('ctrl+alt+g')
  const marker = `${root}/.claude-plugin/orca-managed.json`
  const ownership = memory.fs.files.get(marker)
  expect(JSON.parse(ownership ?? '{}').binding).toEqual({ context: 'Chat', chord: 'ctrl+alt+g' })
  await installClaudeAgentViewRemote(memory.sftp, config)
  expect(memory.fs.files.get(marker)).toBe(ownership)
})

it('installs alongside other skills and plugins without changing their settings or shortcuts', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-agent-view-'))
  roots.push(root)
  mkdirSync(join(root, 'skills', 'user-skill'), { recursive: true })
  writeFileSync(join(root, 'skills', 'user-skill', 'SKILL.md'), 'User skill')
  const settings = JSON.stringify({
    enabledPlugins: { 'user@market': true },
    env: { CLAUDE_CODE_PLUGIN_DIRS: '/my/inline/plugin' }
  })
  writeFileSync(join(root, 'settings.json'), settings)
  const userBlock = {
    context: 'Chat',
    bindings: { 'ctrl+alt+g': 'command:user-command', 'ctrl+a': null }
  }
  writeFileSync(
    join(root, 'keybindings.json'),
    JSON.stringify({ custom: true, bindings: [userBlock] })
  )
  installClaudeAgentView(join(root, 'settings.json'))
  const installed = readFileSync(join(root, 'keybindings.json'), 'utf8')
  expect(JSON.parse(installed)).toEqual({
    custom: true,
    bindings: [
      userBlock,
      { context: 'Chat', bindings: { 'ctrl+alt+h': 'command:orca-agent-view' } }
    ]
  })
  expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe(settings)
  expect(readFileSync(join(root, 'skills', 'user-skill', 'SKILL.md'), 'utf8')).toBe('User skill')
  expect(
    readFileSync(join(root, 'skills', 'orca-agent-view', 'hooks', 'register.js'), 'utf8')
  ).toContain('$.ui.view(')
  installClaudeAgentView(join(root, 'settings.json'))
  expect(readFileSync(join(root, 'keybindings.json'), 'utf8')).toBe(installed)
})

it('leaves unreadable or malformed user bindings untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-agent-view-'))
  roots.push(root)
  writeFileSync(join(root, 'keybindings.json'), '{broken')
  installClaudeAgentView(join(root, 'settings.json'))
  expect(readFileSync(join(root, 'keybindings.json'), 'utf8')).toBe('{broken')
})

it('preserves JSONC comments and trailing commas through install and removal', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-agent-view-'))
  roots.push(root)
  const path = join(root, 'keybindings.json')
  const original = `{
    // My keybindings
    "bindings": [{ "context": "Chat", "bindings": {
      // This user binding must survive
      "Alt+Control+G": "command:user-command",
    } }],
  }`
  writeFileSync(path, original)
  installClaudeAgentView(join(root, 'settings.json'))
  const installed = readFileSync(path, 'utf8')
  expect(installed).toContain('// My keybindings')
  expect(installed).toContain('// This user binding must survive')
  expect(claudeAgentViewChord(installed)).toBe('ctrl+alt+h')
  installClaudeAgentView(join(root, 'settings.json'))
  expect(readFileSync(path, 'utf8')).toBe(installed)
  removeClaudeAgentView(join(root, 'settings.json'))
  const removed = readFileSync(path, 'utf8')
  expect(removed).toContain('// This user binding must survive')
  expect(parse(removed).bindings[0].bindings['Alt+Control+G']).toBe('command:user-command')
  expect(claudeAgentViewChord(removed)).toBeUndefined()
})

it('respects equivalent modifier orders and chord prefixes, and declines exhausted shortcuts', () => {
  expect(
    withClaudeAgentViewShortcut({
      bindings: [
        {
          context: 'Global',
          bindings: {
            'Alt+Control+G': 'user:action',
            'opt+ctrl+h x': 'user:chord'
          }
        }
      ]
    })?.bindings
  ).toContainEqual({ context: 'Chat', bindings: { 'ctrl+alt+v': 'command:orca-agent-view' } })
  expect(
    withClaudeAgentViewShortcut({
      bindings: [
        {
          context: 'Chat',
          bindings: {
            'alt+ctrl+g': null,
            'ctrl+alt+h': null,
            'ctrl+alt+v': null
          }
        }
      ]
    })
  ).toBeNull()
})

it('never overwrites an unowned skill and removes only its own installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-agent-view-'))
  roots.push(root)
  const folder = join(root, 'skills', 'orca-agent-view')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'SKILL.md'), 'user-owned')
  installClaudeAgentView(join(root, 'settings.json'))
  removeClaudeAgentView(join(root, 'settings.json'))
  expect(readFileSync(join(folder, 'SKILL.md'), 'utf8')).toBe('user-owned')
  rmSync(folder, { recursive: true })
  writeFileSync(
    join(root, 'keybindings.json'),
    JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'ctrl+a': 'user:action' } }] })
  )
  installClaudeAgentView(join(root, 'settings.json'))
  removeClaudeAgentView(join(root, 'settings.json'))
  expect(JSON.parse(readFileSync(join(root, 'keybindings.json'), 'utf8')).bindings).toEqual([
    { context: 'Chat', bindings: { 'ctrl+a': 'user:action' } },
    { context: 'Chat', bindings: {} }
  ])
})

it('removes only its recorded binding across reinstalls, preserving other contexts and chords', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-agent-view-'))
  roots.push(root)
  const settings = join(root, 'settings.json')
  const path = join(root, 'keybindings.json')
  installClaudeAgentView(settings)
  const config = JSON.parse(readFileSync(path, 'utf8'))
  const userBindings = [
    { context: 'Global', bindings: { 'ctrl+alt+g': 'command:orca-agent-view' } },
    { context: 'Chat', bindings: { 'ctrl+x': 'command:orca-agent-view' } }
  ]
  config.bindings.push(...userBindings)
  writeFileSync(path, JSON.stringify(config))
  installClaudeAgentView(settings)
  removeClaudeAgentView(settings)
  expect(JSON.parse(readFileSync(path, 'utf8')).bindings).toEqual([
    { context: 'Chat', bindings: {} },
    ...userBindings
  ])
})

it.each([false, true])('preserves reused user bindings with a legacy marker: %s', (legacy) => {
  const root = mkdtempSync(join(tmpdir(), 'orca-agent-view-'))
  roots.push(root)
  const settings = join(root, 'settings.json')
  const path = join(root, 'keybindings.json')
  const original = JSON.stringify({
    bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+g': 'command:orca-agent-view' } }]
  })
  writeFileSync(path, original)
  if (legacy) {
    const markerDir = join(root, 'skills', 'orca-agent-view', '.claude-plugin')
    mkdirSync(markerDir, { recursive: true })
    writeFileSync(
      join(markerDir, 'orca-managed.json'),
      '{"owner":"stablyai/orca/claude-agent-view"}'
    )
  }
  installClaudeAgentView(settings)
  installClaudeAgentView(settings)
  removeClaudeAgentView(settings)
  expect(readFileSync(path, 'utf8')).toBe(original)
})

it('does not claim an existing remote binding', async () => {
  const memory = createAgentHookMemorySftp({
    '/home/remote/.claude/keybindings.json': JSON.stringify({
      bindings: [{ context: 'Chat', bindings: { 'ctrl+alt+g': 'command:orca-agent-view' } }]
    })
  })
  await installClaudeAgentViewRemote(memory.sftp, '/home/remote/.claude/settings.json')
  const marker = memory.fs.files.get(
    '/home/remote/.claude/skills/orca-agent-view/.claude-plugin/orca-managed.json'
  )
  expect(JSON.parse(marker ?? '{}')).toEqual({ owner: 'stablyai/orca/claude-agent-view' })
})
