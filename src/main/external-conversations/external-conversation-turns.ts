import { buildAgentTuiClearInputForText } from '../../shared/agent-tui-input-clear'
import type { ExternalConversationLink } from '../../shared/external-conversation-link'
import { composerDraftShowsText } from '../../shared/terminal-composer-draft'
import {
  createLaunchedAgentWriteGuard,
  type LaunchedAgentWriteGuardRuntime
} from '../runtime/launched-agent-write-guard'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AgentPromptExpectedBinding } from '../runtime/runtime-terminal-contracts'
import {
  writeFencedAgentKeys,
  type FencedAgentKeysOutcome
} from '../runtime/terminal-agent-fenced-keys'
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

// Claude can restore an interrupted prompt; only its next send may clear matching input.
export class ConversationTurns {
  // Per conversation, the last turn text handed to its agent and the process it went to.
  private readonly turns = new Map<string, Turn>()

  wrote(id: string, text: string, binding: AgentPromptExpectedBinding): void {
    this.turns.set(id, { text, binding, interrupted: false })
  }

  current(id: string): Turn | undefined {
    return this.turns.get(id)
  }

  interrupted(id: string, binding: AgentPromptExpectedBinding, turn: Turn | undefined): void {
    if (turn && this.turns.get(id) === turn && sameBinding(turn.binding, binding)) {
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
    if (link.agent === 'claude' && turn?.interrupted && sameBinding(turn.binding, pane.binding)) {
      // A clear that may have half-landed gets no follow-up pasted after it; the mark stays for the next.
      if ((await clearRestoredPrompt(terminal, link, pane, turn.text, signal)) === 'unknown') {
        return { outcome: 'unknown', reason: 'writer_failed' }
      }
    }
    this.turns.delete(id)
    const delivery = await deliverFollowUp(terminal, {
      handle: pane.handle,
      expectedBinding: pane.binding,
      agent: link.agent,
      text,
      requestId: JSON.stringify([key.source, key.externalId, deliveryId]),
      signal
    })
    if (delivery.outcome === 'accepted' && !signal.aborted) {
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
): Promise<FencedAgentKeysOutcome['outcome']> {
  // Clear keys at a shell that replaced the agent would wipe the user's command line.
  const guard = createLaunchedAgentWriteGuard(terminal, link.agent, {
    unprovableHost: 'write-unless-shell'
  })
  try {
    const cleared = await writeFencedAgentKeys(
      terminal,
      pane.handle,
      buildAgentTuiClearInputForText(text),
      {
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
      }
    )
    return cleared.outcome
  } finally {
    guard.dispose()
  }
}
