import type { TuiAgent } from '../../shared/tui-agent'
import { findTerminalWaitBlockedSignal } from './agent-state-rules/blocked-text-layer'
import { evaluateAgentStateRules } from './agent-state-rules/agent-state-rules-engine'

/**
 * Whether a settled grid proves blocked text in the line tail is an erased dialog (#24187): no
 * blocker anywhere on screen, and the agent's own screen rules see its ready composer. An agent
 * without screen rules never clears here, so the tail decides as before.
 */
export function screenClearsBlockedTail(
  agent: TuiAgent | null,
  screenLines: readonly string[]
): boolean {
  const screen = screenLines.join('\n').toLowerCase()
  if (findTerminalWaitBlockedSignal(screen, { wholeText: true }) !== null) {
    return false
  }
  return evaluateAgentStateRules(agent, { readScreenLines: () => screenLines })?.state === 'idle'
}
