// The journal as a catch-up would leave it, kept in memory: the bound journal's rows with the
// staged writes over them. The assembler writes imported history here exactly as it writes a live
// turn, each step read against every earlier write, and nothing reaches the real journal until the
// whole import is known; it then lands as one settlement, so no part of it is ever durable alone.

import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import {
  journalLifecycleItemMutation,
  journalLifecycleMutationItemId,
  type JournalLifecycleMutationInput
} from '../native-chat/agent-session-journal/journal-lifecycle-mutation'
import type { ProviderTimelineSink } from '../native-chat/agent-session-timeline/provider-timeline-plan'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'

type ItemMutation = Extract<JournalLifecycleMutationInput, { kind: 'item' }>
type StagedItem = { item: AgentJournalRenderItem; mutation: ItemMutation }

export class AcpHistoryJournalOverlay {
  private readonly staged = new Map<string, StagedItem>()
  private readonly base: StructuredAgentSessionTransitionJournal
  private sequence = 0
  readonly journal: StructuredAgentSessionTransitionJournal
  /** A sink that runs each transition at once against the overlay, as the journal would. */
  readonly sink: ProviderTimelineSink

  constructor(base: StructuredAgentSessionTransitionJournal) {
    this.base = base
    base.visitItems((_itemId, sequence) => {
      this.sequence = Math.max(this.sequence, sequence)
    })
    const item = (itemId: string) => this.staged.get(itemId)?.item ?? base.item(itemId)
    const visitItemsWithLinkage: StructuredAgentSessionTransitionJournal['visitItemsWithLinkage'] =
      (visit) => {
        base.visitItemsWithLinkage((itemId, sequence, body, attribution) => {
          const staged = this.staged.get(itemId)?.item
          visit(itemId, sequence, staged?.body ?? body, staged ?? attribution)
        })
        for (const [itemId, staged] of this.staged) {
          if (!base.item(itemId)) {
            visit(itemId, staged.item.sequence, staged.item.body, staged.item)
          }
        }
      }
    this.journal = {
      epoch: base.epoch,
      canonicalItemId: (itemId) => base.canonicalItemId(itemId),
      item,
      itemBody: (itemId) => item(itemId)?.body ?? null,
      visitItems: (visit) => visitItemsWithLinkage(visit),
      visitItemsWithLinkage
    }
    this.sink = {
      journalItems: () => this.journal,
      tryAppendTransition: (transition) => {
        for (const step of transition.steps) {
          if (step.kind === 'settlement') {
            step.resolve(this.journal).forEach((mutation) => this.write(mutation))
            continue
          }
          const resolved = step.resolve(this.journal)
          if (resolved) {
            this.write(journalLifecycleItemMutation(step.options, resolved.identity, resolved.body))
          }
        }
        return { accepted: true }
      }
    }
  }

  /** Every row the staged writes created or revised. */
  touched(): string[] {
    return [...this.staged.keys()]
  }

  /** One write per row this import creates, in creation order with its final body; rows the
   *  journal already held are never rewritten. */
  created(): JournalLifecycleMutationInput[] {
    return [...this.staged]
      .filter(([itemId]) => !this.base.item(itemId))
      .map(([, { mutation }]) => mutation)
  }

  private write(mutation: JournalLifecycleMutationInput): void {
    if (mutation.kind !== 'item') {
      throw new Error('unexpected-history-tombstone')
    }
    const itemId = journalLifecycleMutationItemId(mutation)
    const previous = this.staged.get(itemId)
    const held = previous?.item ?? this.base.item(itemId)
    // A row keeps the turn and producer of the write that created it.
    const turnScope = held?.turnScope ?? mutation.turnScope
    const body: AgentJournalItemBody = mutation.body
    this.staged.set(itemId, {
      item: {
        ...(held ?? mutation.linkage),
        itemId,
        revision: (held?.revision ?? 0) + 1,
        body,
        sequence: held?.sequence ?? ++this.sequence,
        observedAt: held?.observedAt ?? 0,
        turnScope
      },
      mutation: {
        ...(previous?.mutation ?? mutation),
        body,
        turnScope,
        ...(isUserMessage(body) ? { echoOf: null } : {})
      }
    })
  }
}

/** Imported history is never a send's echo, so it can't settle one. */
function isUserMessage(body: AgentJournalItemBody): boolean {
  return body.kind === 'message' && body.role === 'user'
}
