import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

// AskUserQuestion, permission and plan-approval dialogs all paint a numbered list with this cursor.
const CLAUDE_SELECTOR_ROW_RE = /^\s*❯ \d+\. /

/**
 * Whether a Claude dialog still holds the pane: Claude keeps its `✳` rest title under it, so
 * without OSC 7501 only the hook row shows it. Esc dismisses it without a hook, so once input
 * follows the row only a selector still on screen (or an unreadable screen) keeps the hold.
 */
export function isClaudeDialogHoldingPane(args: {
  row: AgentStatusIpcPayload | null
  respawnedAt: number | undefined
  lastInputAt: number | null
  readScreenLines: () => readonly string[] | null
}): boolean {
  const { row } = args
  if (
    row?.agentType !== 'claude' ||
    (row.state !== 'waiting' && row.state !== 'blocked') ||
    row.receivedAt < (args.respawnedAt ?? -1)
  ) {
    return false
  }
  if (row.receivedAt >= (args.lastInputAt ?? -1)) {
    return true
  }
  const lines = args.readScreenLines()
  return lines === null || lines.some((line) => CLAUDE_SELECTOR_ROW_RE.test(line))
}
