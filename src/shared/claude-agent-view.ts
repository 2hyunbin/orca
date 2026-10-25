export const CLAUDE_AGENT_VIEW_PATH = '/claude/agent-view'
export const CLAUDE_AGENT_VIEW_RELAY_METHOD = 'agent_hook.claudeAgentView'
export const CLAUDE_AGENT_VIEW_COMMAND = 'orca-agent-view'
export const CLAUDE_AGENT_VIEW_PLUGIN = 'orca-agent-view'

export function normalizeClaudeAgentViewChord(chord: string): string {
  return chord
    .toLowerCase()
    .replace(/control/g, 'ctrl')
    .replace(/option|opt/g, 'alt')
    .trim()
    .split(/\s+/)
    .map((stroke) => stroke.split('+').sort().join('+'))
    .join(' ')
}

export const CLAUDE_AGENT_VIEW_SHORTCUTS = [
  { chord: 'ctrl+alt+g', input: '\u001b[103;7u' },
  { chord: 'ctrl+alt+h', input: '\u001b[104;7u' },
  { chord: 'ctrl+alt+v', input: '\u001b[118;7u' }
] as const

export type ClaudeAgentViewResult = {
  status: 'viewed' | 'unsupported' | 'busy' | 'permission' | 'unavailable' | 'denied' | 'timeout'
  reason?: string
}
