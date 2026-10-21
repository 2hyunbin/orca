import { describe, expect, it } from 'vitest'
import {
  agentLaunchSettingsMutationUpdates,
  projectAgentLaunchSettings,
  type AgentLaunchSettingsSource
} from './agent-launch-settings'
import { newChatPermissionModeForSettings } from './agent-chat-permission-mode'
import {
  DEFAULT_TUI_AGENT_ARGS,
  DEFAULT_TUI_AGENT_ENV,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from './tui-agent-launch-defaults'
import { applyAllAgentsPermission, resolveAgentPermission } from './tui-agent-permission-choice'
import { migrateAgentPermissionChoice } from './tui-agent-permission-lift'

const legacy = (
  args: Record<string, string>,
  env: Record<string, Record<string, string>> = {}
): AgentLaunchSettingsSource => ({
  agentDefaultArgs: { ...DEFAULT_TUI_AGENT_ARGS, ...args },
  agentDefaultEnv: { ...DEFAULT_TUI_AGENT_ENV, ...env }
})

describe('one-time move of permission flags out of Arguments', () => {
  it('turns saved shapes into a stored choice and leaves the rest of the text', () => {
    const migrated = migrateAgentPermissionChoice(
      legacy(
        {
          claude: '--model opus --dangerously-skip-permissions',
          codex: '--approve-for-me -c model_reasoning_effort="high"',
          gemini: '',
          // Not one of Orca's flags: left whole, and Orca adds nothing.
          grok: '--permission-mode plan'
        },
        { goose: { goose_mode: 'auto', OTHER: '1' } }
      )
    )
    expect(migrated.agentPermissionDefault).toBe('full-access')
    expect(migrated.agentDefaultArgs).toMatchObject({
      claude: '--model opus',
      codex: '-c model_reasoning_effort="high"',
      gemini: '',
      grok: '--permission-mode plan',
      cursor: ''
    })
    // Windows reads env names case-insensitively; unrelated entries stay.
    expect(migrated.agentDefaultEnv.goose).toEqual({ OTHER: '1' })
    expect(migrated.agentPermissionOverrides).toEqual({
      codex: 'auto',
      gemini: 'own',
      grok: 'own'
    })
    // Terminals launch what they launched before the move.
    expect(resolveTuiAgentLaunchArgs('claude', migrated)).toBe(
      '--dangerously-skip-permissions --model opus'
    )
    expect(resolveTuiAgentLaunchArgs('grok', migrated)).toBe('--permission-mode plan')
    expect(resolveTuiAgentLaunchEnv('goose', migrated)).toEqual({ GOOSE_MODE: 'auto', OTHER: '1' })
  })

  it('cuts a flag beside quoted text, and leaves a quoted flag as the user’s own text', () => {
    const migrated = migrateAgentPermissionChoice(
      legacy({ claude: '--name "a b" --dangerously-skip-permissions' })
    )
    expect(migrated.agentDefaultArgs.claude).toBe('--name "a b"')
    const quoted = migrateAgentPermissionChoice(
      legacy({ claude: '"--dangerously-skip-permissions"' })
    )
    expect(quoted.agentPermissionOverrides.claude).toBe('own')
    expect(quoted.agentDefaultArgs.claude).toBe('"--dangerously-skip-permissions"')
  })
})

describe('terminal launch composes the stored choice', () => {
  const typed = {
    agentPermissionDefault: 'full-access',
    agentPermissionOverrides: { claude: 'ask', codex: 'own' },
    agentDefaultArgs: { claude: '--model opus', codex: '--search', grok: '--permission-mode plan' }
  } as const

  it('adds Orca’s flag ahead of the user’s text, nothing for own or text that sets permissions', () => {
    expect(resolveTuiAgentLaunchArgs('claude', typed)).toBe(
      '--permission-mode default --model opus'
    )
    expect(resolveTuiAgentLaunchArgs('codex', typed)).toBe('--search')
    expect(resolveTuiAgentLaunchArgs('grok', typed)).toBe('--permission-mode plan')
    expect(resolveTuiAgentLaunchArgs('gemini', typed)).toBe('--yolo')
    // An agent with no flag for a choice falls to its own settings rather than claiming it.
    expect(resolveAgentPermission('gemini', { agentPermissionDefault: 'ask' }).choice).toBe('own')
  })

  it('passes an older host’s published text through unchanged', () => {
    expect(
      resolveTuiAgentLaunchArgs('claude', {
        agentDefaultArgs: { claude: '--permission-mode auto' }
      })
    ).toBe('--permission-mode auto')
  })

  it('Auto for all agents keeps the others on what they had', () => {
    const next = applyAllAgentsPermission({ agentPermissionDefault: 'full-access' }, 'auto')
    expect(resolveAgentPermission('claude', next).choice).toBe('auto')
    expect(resolveAgentPermission('gemini', next).choice).toBe('full-access')
  })
})

describe('older clients against a host with the stored choice', () => {
  const host = {
    ...migrateAgentPermissionChoice(legacy({ codex: '--approve-for-me --search' })),
    nativeChatPermissionMode: 'ask'
  } satisfies AgentLaunchSettingsSource

  it('see Arguments with the flag included', () => {
    const projected = projectAgentLaunchSettings(host)
    expect(projected.agentDefaultArgs.codex).toBe('--approve-for-me --search')
    expect(projected.agentPermission?.userArgs.codex).toBe('--search')
  })

  it('deleting the published flag means the agent’s own settings; another flag becomes the choice', () => {
    const deleted = agentLaunchSettingsMutationUpdates(
      host,
      { type: 'arguments', agent: 'codex', value: '--search' },
      'linux'
    )
    expect(resolveAgentPermission('codex', { ...host, ...deleted }).choice).toBe('own')
    const swapped = agentLaunchSettingsMutationUpdates(
      host,
      {
        type: 'arguments',
        agent: 'codex',
        value: '--dangerously-bypass-approvals-and-sandbox --search'
      },
      'linux'
    )
    expect({ ...host, ...swapped }.agentDefaultArgs?.codex).toBe('--search')
    expect(resolveAgentPermission('codex', { ...host, ...swapped }).choice).toBe('full-access')
    const manual = agentLaunchSettingsMutationUpdates(
      host,
      { type: 'permissions', mode: 'manual', agent: 'claude' },
      'linux'
    )
    expect(resolveTuiAgentLaunchArgs('claude', { ...host, ...manual })).toBe('')
  })

  it('new chats start in the stored choice; agents on their own settings keep the Chat default', () => {
    expect(newChatPermissionModeForSettings('codex', host)).toBe('auto')
    const own = { ...host, agentPermissionOverrides: { codex: 'own' as const } }
    expect(newChatPermissionModeForSettings('codex', own)).toBe('ask')
  })
})
