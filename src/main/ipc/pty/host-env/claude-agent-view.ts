import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import {
  ensureClaudeAgentViewPlugin,
  installClaudeAgentView,
  refreshClaudeAgentView
} from '../../../claude/agent-view-install'
import type { BuildPtyHostEnvOptions } from './types'

export function applyClaudeAgentViewEnv(
  env: Record<string, string>,
  opts: BuildPtyHostEnvOptions
): void {
  env.CLAUDE_CODE_PLUGIN_DIRS ??= process.env.CLAUDE_CODE_PLUGIN_DIRS ?? ''
  const previous =
    env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR ?? process.env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR
  if (previous && env.CLAUDE_CODE_PLUGIN_DIRS) {
    const remaining = env.CLAUDE_CODE_PLUGIN_DIRS.split(delimiter).filter(
      (path) => path !== previous
    )
    env.CLAUDE_CODE_PLUGIN_DIRS = remaining.join(delimiter)
  }
  delete env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR
  delete env.ORCA_CLAUDE_CONFIG_DIR
  const configDir =
    env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  if (!opts.isWsl && opts.claudeSubagentNavigationEnabled !== true) {
    void refreshClaudeAgentView(join(configDir, 'settings.json')).catch((error: unknown) => {
      console.warn('[agent-hooks] Claude agent view migration failed', error)
    })
  }
  if (
    !opts.agentStatusHooksEnabled ||
    opts.claudeSubagentNavigationEnabled !== true ||
    !isTuiAgentEnabled('claude', opts.disabledTuiAgents) ||
    opts.isWsl
  ) {
    return
  }
  try {
    if (!installClaudeAgentView(join(configDir, 'settings.json'))) {
      return
    }
    const root = ensureClaudeAgentViewPlugin(opts.userDataPath)
    const paths = env.CLAUDE_CODE_PLUGIN_DIRS?.split(delimiter).filter(Boolean) ?? []
    if (!paths.includes(root)) {
      paths.push(root)
    }
    env.CLAUDE_CODE_PLUGIN_DIRS = paths.join(delimiter)
    env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR = root
    env.ORCA_CLAUDE_CONFIG_DIR = configDir
  } catch (error) {
    console.warn('[agent-hooks] Claude subagent navigation setup failed', error)
  }
}
