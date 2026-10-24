import { buildAgentTuiClearInputForText } from '../../shared/agent-tui-input-clear'
import type { ExternalConversationLink } from '../../shared/external-conversation-link'
import { composerDraftShowsText } from '../../shared/terminal-composer-draft'
import {
  createLaunchedAgentWriteGuard,
  type LaunchedAgentWriteGuardRuntime
} from '../runtime/launched-agent-write-guard'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AgentPromptExpectedBinding } from '../runtime/runtime-terminal-contracts'
import { writeFencedAgentKeys } from '../runtime/terminal-agent-fenced-keys'
import { deliverFollowUp, sameBinding, type FollowUpTerminal } from './external-conversation-send'
import type { ConversationKey, Delivery } from './external-conversation-types'
import { conversationId } from './external-conversation-types'

export type TurnTerminal = FollowUpTerminal &
  Pick<
    OrcaRuntimeService,
    'getTerminalPromptRequestBinding' | 'sendTerminal' | 'readTerminalComposerDraft'
  > &
  LaunchedAgentWriteGuardRuntime

type Turn = { text: string; binding: AgentPromptExpectedBinding; interrupted: boolean }

/**
 * A conversation's turn writes, and what an interrupted one leaves behind: Claude puts a prompt
 * interrupted before any reply back in its input box, so the next turn would be pasted after it.
 * Like the phone's stale-input marker, our accepted cancel marks the turn, and the next write
 * clears the box first only if it still shows exactly that text. The mark is spent either way.
 */
export class ConversationTurns {
  // Per conversation, the last turn text handed to its agent and the process it went to.
  private readonly turns = new Map<string, Turn>()

  wrote(id: string, text: string, binding: AgentPromptExpectedBinding): void {
    this.turns.set(id, { text, binding, interrupted: false })
  }

  interrupted(id: string, binding: AgentPromptExpectedBinding): void {
    const turn = this.turns.get(id)
    if (turn && sameBinding(turn.binding, binding)) {
      turn.interrupted = true
    }
  }

  forget(id: string): void {
    this.turns.delete(id)
  }

  /** One follow-up through the shared writer, after clearing a prompt our cancel left behind. */
  async write(
    terminal: TurnTerminal,
    key: ConversationKey,
    link: ExternalConversationLink,
    pane: { handle: string; binding: AgentPromptExpectedBinding },
    deliveryId: string,
    text: string,
    signal: AbortSignal
  ): Promise<Delivery> {
    const id = conversationId(key)
    const turn = this.turns.get(id)
    this.turns.delete(id)
    if (turn?.interrupted && sameBinding(turn.binding, pane.binding)) {
      await clearRestoredPrompt(terminal, link, pane, turn.text, signal)
    }
    const delivery = await deliverFollowUp(terminal, {
      handle: pane.handle,
      expectedBinding: pane.binding,
      agent: link.agent,
      text,
      requestId: JSON.stringify([key.source, key.externalId, deliveryId]),
      signal
    })
    if (delivery.outcome !== 'refused') {
      this.wrote(id, text, pane.binding)
    }
    return delivery
  }
}

async function clearRestoredPrompt(
  terminal: TurnTerminal,
  link: ExternalConversationLink,
  pane: { handle: string; binding: AgentPromptExpectedBinding },
  text: string,
  signal: AbortSignal
): Promise<void> {
  // Clear keys at a shell that replaced the agent would wipe the user's command line.
  const guard = createLaunchedAgentWriteGuard(terminal, link.agent, {
    unprovableHost: 'write-unless-shell'
  })
  try {
    await writeFencedAgentKeys(terminal, pane.handle, buildAgentTuiClearInputForText(text), {
      signal,
      beforeWrite: (ptyId) => guard.beforeWrite(ptyId),
      // Synchronous with the write, so the box is read just before the clear goes in.
      fence: (ptyId) => {
        const { processIncarnation } = terminal.getTerminalPromptRequestBinding(pane.handle)
        const draft = terminal.readTerminalComposerDraft(ptyId)
        if (
          signal.aborted ||
          ptyId !== pane.binding.ptyId ||
          processIncarnation !== pane.binding.processIncarnation ||
          draft === null ||
          !composerDraftShowsText(draft, text)
        ) {
          throw new Error('input_not_stale')
        }
      }
    })
  } finally {
    guard.dispose()
  }
}
