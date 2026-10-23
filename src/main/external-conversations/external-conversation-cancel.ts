import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { ExternalConversationLink } from '../../shared/external-conversation-link'
import { createLaunchedAgentWriteGuard } from '../runtime/launched-agent-write-guard'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { interruptWorkingAgent } from '../runtime/terminal-agent-interrupt'
import type { ConversationPrompts, PromptTerminal } from './external-conversation-prompts'
import type { ConversationChain } from './external-conversation-chain'
import { findLink } from './external-conversation-links'
import type { ExternalConversationSeamDeps } from './external-conversation-seam'
import { bindPane } from './external-conversation-send'
import {
  conversationId,
  refused,
  type ConversationKey,
  type Delivery
} from './external-conversation-types'

export type CancelTerminal = PromptTerminal & Pick<OrcaRuntimeService, 'getPtyLivenessVerdict'>

/**
 * Settles the conversation's queued and held work first, so a follow-up held behind an approval
 * is not pasted once the reject lands, then stops what its agent is doing now.
 */
export async function cancelConversation(
  terminal: CancelTerminal,
  { store, readHookRow }: Pick<ExternalConversationSeamDeps, 'store' | 'readHookRow'>,
  prompts: ConversationPrompts,
  chain: ConversationChain,
  key: ConversationKey,
  signal: AbortSignal
): Promise<Delivery> {
  if (signal.aborted) {
    return refused('connectors_disabled')
  }
  const settledWork = chain.cancel(conversationId(key), 'conversation_cancelled')
  const linked = findLink(store, key)
  if (!linked) {
    // A start not yet linked has reached no agent, so settling it stopped everything.
    if (settledWork) {
      return { outcome: 'accepted' }
    }
    throw new Error('external_conversation_not_found')
  }
  return stopLinkedAgent(terminal, prompts, readHookRow, linked.link, signal)
}

/**
 * Stops the linked agent on the host's own word: an approval it waits on is rejected, a turn it
 * reports working gets one Escape. Idle, it is left alone and the cancel is an accepted no-op, so
 * its receipt keeps a retried delivery from interrupting a later turn. Nothing here says the agent
 * stopped: that is the turn-end verdict the host records.
 */
async function stopLinkedAgent(
  terminal: CancelTerminal,
  prompts: ConversationPrompts,
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null,
  link: ExternalConversationLink,
  signal: AbortSignal
): Promise<Delivery> {
  const pane = bindPane(terminal, link.paneKey)
  // A host out of contact cannot show the agent idle; refused leaves no receipt, so a retry acts.
  if (!pane || terminal.getPtyLivenessVerdict(pane.binding.ptyId)?.status === 'unverifiable') {
    return refused('agent_not_reachable')
  }
  const prompt = prompts.pending(terminal, link)
  if (prompt) {
    return prompt.kind === 'approval'
      ? prompts.answer(terminal, link, {
          promptId: prompt.promptId,
          optionId: 'reject_once',
          signal
        })
      : refused('prompt_unsupported')
  }
  // An Escape at a shell that replaced the agent would clear the user's command line.
  const guard = createLaunchedAgentWriteGuard(terminal, link.agent, {
    unprovableHost: 'write-unless-shell'
  })
  try {
    const interrupted = await interruptWorkingAgent(terminal, readHookRow, link.paneKey, {
      beforeWrite: (ptyId) => guard.beforeWrite(ptyId),
      signal
    })
    switch (interrupted.outcome) {
      case 'accepted':
        return interrupted
      case 'unknown':
        return { outcome: 'unknown', reason: 'writer_failed' }
      case 'refused':
        return interrupted.reason === 'agent_not_working'
          ? { outcome: 'accepted' }
          : refused('agent_not_reachable')
    }
  } finally {
    guard.dispose()
  }
}
