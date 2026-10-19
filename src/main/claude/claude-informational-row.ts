// Only a `warning` frame (a UserPromptSubmit hook that blocked the prompt, say) earns a row, in its
// own words; `info`, `notice` (a hook's systemMessage) and `suggestion` are session chrome, not chat rows.

import {
  AGENT_SESSION_HOOK_OUTCOME_PRESENTATION,
  hookOutcomeRowBody,
  type AgentSessionHookOutcome
} from '../../shared/agent-session-hook-outcome'
import type { AgentJournalStatusItem } from '../../shared/agent-session-journal-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { claudeRecord, claudeText } from './claude-structured-item-translation'

export const CLAUDE_INFORMATIONAL_FRAME_KIND = 'message:system:informational'

const STRUCTURED_OUTCOMES = new Map<unknown, AgentSessionHookOutcome>([
  ['blocked_by_hook', 'blocked'],
  ['stopped_by_hook', 'stopped']
])
// Older Claude sends only its sentence: the reason, then the hook's path and a copy of the prompt.
const SENTENCE_OUTCOMES: [RegExp, AgentSessionHookOutcome][] = [
  [/^\S+ operation blocked by hook:\s*/, 'blocked'],
  [/^Operation stopped by hook:?\s*/, 'stopped']
]

function hookOutcomeOf(message: Record<string, unknown>, text: string) {
  const structured = claudeRecord(message.prompt_submit_outcome)
  const outcome = STRUCTURED_OUTCOMES.get(structured?.kind)
  if (outcome) {
    return hookOutcomeRowBody(outcome, [claudeText(structured?.reason) ?? ''])
  }
  const sentence = SENTENCE_OUTCOMES.find(([prefix]) => prefix.test(text))
  if (!sentence) {
    return null
  }
  const reason = text.replace(sentence[0], '').split(/\n+Original prompt:/)[0] ?? ''
  return hookOutcomeRowBody(sentence[1], [reason.replace(/^\[[^\]\n]+\]: /, '')])
}

/** The row a warning-level note writes; null for every other level and for a warning with no words. */
export function claudeInformationalRowBody(
  message: Record<string, unknown>
): AgentJournalStatusItem | null {
  const text = message.level === 'warning' ? claudeText(message.content)?.trim() : null
  if (!text) {
    return null
  }
  // A warning that halts the prompt is a hook's outcome, shown whether or not its words are known.
  const halts = message.prevent_continuation === true
  const row = (halts ? hookOutcomeOf(message, text) : null) ?? {
    kind: 'status' as const,
    tone: 'warning',
    text,
    ...(halts ? { presentation: AGENT_SESSION_HOOK_OUTCOME_PRESENTATION } : {})
  }
  return { ...row, text: boundInlineText(row.text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }
}
