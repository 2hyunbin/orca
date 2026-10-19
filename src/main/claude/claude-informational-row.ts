// Only a `warning` frame (a UserPromptSubmit hook that blocked the prompt, say) earns a row, in its
// own words; `info`, `notice` (a hook's systemMessage) and `suggestion` are session chrome, not chat rows.

import {
  AGENT_SESSION_HOOK_OUTCOME_PRESENTATION,
  hookOutcomeRowBody
} from '../../shared/agent-session-hook-outcome'
import type { AgentJournalStatusItem } from '../../shared/agent-session-journal-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { claudeRecord, claudeText } from './claude-structured-item-translation'

export const CLAUDE_INFORMATIONAL_FRAME_KIND = 'message:system:informational'

/** The row a warning-level note writes; null for every other level and for a warning with no words. */
export function claudeInformationalRowBody(
  message: Record<string, unknown>
): AgentJournalStatusItem | null {
  const text = message.level === 'warning' ? claudeText(message.content)?.trim() : null
  if (!text) {
    return null
  }
  // A warning that halts the prompt is a hook's outcome; the words come from the structured
  // outcome when Claude sends one, else from its own sentence.
  const halts = message.prevent_continuation === true
  const outcome = halts ? claudeRecord(message.prompt_submit_outcome) : null
  const status =
    outcome?.kind === 'blocked_by_hook'
      ? 'blocked'
      : outcome?.kind === 'stopped_by_hook'
        ? 'stopped'
        : null
  const row = status
    ? hookOutcomeRowBody(status, [claudeText(outcome?.reason) ?? ''])
    : {
        kind: 'status' as const,
        tone: 'warning',
        text,
        ...(halts ? { presentation: AGENT_SESSION_HOOK_OUTCOME_PRESENTATION } : {})
      }
  return { ...row, text: boundInlineText(row.text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }
}
