import type { ToolSnapshot } from '../listener-event'
import { readString } from '../tool-input-preview'
import { extractClaudeToolFields } from './claude-tool-fields'

/**
 * Kiro's camelCase hook names mapped onto the Claude names its payload fields mirror; the
 * V3 engine already sends the Claude names, so those map to themselves.
 */
export const KIRO_CLAUDE_EVENT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  agentSpawn: 'SessionStart',
  userPromptSubmit: 'UserPromptSubmit',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  stop: 'Stop',
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  Stop: 'Stop'
})

/** Kiro keeps Claude tool fields, maps camelCase events and sends final text in assistant_response. */
export function extractKiroToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  const claudeEventName = typeof eventName === 'string' ? KIRO_CLAUDE_EVENT_NAMES[eventName] : null
  if (!claudeEventName) {
    return {}
  }
  if (claudeEventName !== 'Stop') {
    return extractClaudeToolFields(claudeEventName, hookPayload)
  }
  const reply = readString(hookPayload, 'assistant_response')
  return reply ? { lastAssistantMessage: reply } : {}
}
