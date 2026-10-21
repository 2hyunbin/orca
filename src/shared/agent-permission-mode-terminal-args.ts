import type { AgentType } from './agent-status-types'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  isAgentChatPermissionMode,
  type AgentChatPermissionMode
} from './agent-chat-permission-mode'
import { agentArgTerminatorIndex, removeAgentArgOption } from './agent-session-option-agent-args'
import { AUTO_TUI_AGENT_ARGS, YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'

type TerminalPermissionFlags = {
  /** A mode left out has no terminal flag; `ask` is the CLI's own prompting, so no flag. */
  modes: Partial<Record<AgentChatPermissionMode, readonly string[]>>
  /** Raw permission flags a saved mode replaces, Agent Permissions' YOLO/Auto arguments included. */
  valueFlags: readonly string[]
  booleanFlags: readonly string[]
}

const split = (args: string | undefined): readonly string[] => args?.split(' ') ?? []

// Rows only for agents whose chats offer modes, so one choice means the same on both routes.
const TERMINAL_PERMISSION_FLAGS: Partial<Record<AgentType, TerminalPermissionFlags>> = {
  claude: {
    modes: {
      ask: [],
      'accept-edits': ['--permission-mode', 'acceptEdits'],
      auto: split(AUTO_TUI_AGENT_ARGS.claude),
      'full-access': split(YOLO_TUI_AGENT_ARGS.claude)
    },
    valueFlags: ['--permission-mode'],
    booleanFlags: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']
  },
  codex: {
    modes: {
      ask: [],
      auto: split(AUTO_TUI_AGENT_ARGS.codex),
      'full-access': split(YOLO_TUI_AGENT_ARGS.codex)
    },
    valueFlags: ['-a', '--ask-for-approval', '-s', '--sandbox'],
    booleanFlags: [
      '--approve-for-me',
      '--dangerously-bypass-approvals-and-sandbox',
      '--full-auto',
      '--yolo'
    ]
  },
  grok: {
    modes: { ask: [], 'full-access': split(YOLO_TUI_AGENT_ARGS.grok) },
    valueFlags: ['--permission-mode'],
    booleanFlags: []
  },
  antigravity: {
    modes: { ask: [], 'full-access': split(YOLO_TUI_AGENT_ARGS.antigravity) },
    valueFlags: [],
    booleanFlags: ['--dangerously-skip-permissions']
  }
}

/** The saved mode a launch carries; paired hosts receive it on the launch preferences' `mode`. */
export function readLaunchPermissionMode(
  values: Readonly<Record<string, unknown>> | null | undefined
): AgentChatPermissionMode | undefined {
  const mode = values?.[AGENT_CHAT_PERMISSION_MODE_OPTION_ID] ?? values?.mode
  return isAgentChatPermissionMode(mode) ? mode : undefined
}

/** Null when this agent's terminal has no flag for the mode, so it applies to chats only. */
export function terminalPermissionModeArgs(
  agent: AgentType,
  mode: AgentChatPermissionMode
): readonly string[] | null {
  return TERMINAL_PERMISSION_FLAGS[agent]?.modes[mode] ?? null
}

export function removeTerminalPermissionArgs(
  agent: AgentType,
  tokens: readonly string[]
): string[] {
  const flags = TERMINAL_PERMISSION_FLAGS[agent]
  if (!flags) {
    return [...tokens]
  }
  let kept = flags.valueFlags.length
    ? removeAgentArgOption(agent, tokens, flags.valueFlags)
    : [...tokens]
  if (agent === 'codex') {
    // Why: Codex also reads its approval and sandbox policy from `-c key=value` overrides.
    kept = removeAgentArgOption(agent, kept, ['-c', '--config'], (value) =>
      /^(approval_policy|sandbox_mode)=/.test(value ?? '')
    )
  }
  const terminator = agentArgTerminatorIndex(agent, kept)
  return [
    ...kept.slice(0, terminator).filter((token) => !flags.booleanFlags.includes(token)),
    ...kept.slice(terminator)
  ]
}
