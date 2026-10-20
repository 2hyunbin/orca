import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { CliConversationRowAgent } from '../../../../shared/structured-agent-cli-conversation-adoption'

/** The conversation a switch put in a terminal tab, until its agent reports one. Presentation only:
 *  an agent's first report comes with its first prompt, and the switch back is offered before it. */
type SwitchedTerminalConversation = {
  agent: CliConversationRowAgent
  providerSessionId: string
  executionHostId: ExecutionHostId
  /** The switch's own pane and PTY, latched when the new tab's only leaf first shows them. */
  leafId?: string
  ptyId?: string
}

const byTabId = new Map<string, SwitchedTerminalConversation>()

export function seedSwitchedTerminalConversation(
  tabId: string,
  conversation: SwitchedTerminalConversation
): void {
  byTabId.set(tabId, conversation)
}

/** Only for the switch's own leaf and PTY; a replaced PTY or a gone leaf ends the seed. */
export function switchedTerminalConversation(
  tabId: string,
  leafId: string | null | undefined,
  layout: TerminalLayoutSnapshot | undefined
): SwitchedTerminalConversation | undefined {
  const seed = byTabId.get(tabId)
  const leaves = Object.keys(layout?.ptyIdsByLeafId ?? {})
  if (seed && !seed.leafId && leaves.length === 1) {
    seed.leafId = leaves[0]
  }
  const ptyId = seed?.leafId ? layout?.ptyIdsByLeafId?.[seed.leafId] : undefined
  if (seed?.leafId && ptyId && seed.ptyId === undefined) {
    seed.ptyId = ptyId
  }
  if (seed?.ptyId && ptyId !== seed.ptyId) {
    byTabId.delete(tabId)
    return undefined
  }
  return seed?.leafId && seed.leafId === leafId ? seed : undefined
}

export function forgetSwitchedTerminalConversation(tabId: string): void {
  byTabId.delete(tabId)
}
