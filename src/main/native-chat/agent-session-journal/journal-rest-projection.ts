import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { compareAgentJournalItems } from '../../../shared/agent-session-journal-position'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { isAgentSessionContextClear } from '../../../shared/agent-session-context-clear'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { latestStructuredAgentSessionRequest } from '../../../shared/structured-agent-session-latest-request'
import type { JournalReducerState } from './journal-reducer'
import { JournalMutationMap } from './journal-mutation-map'
import type { JournalRestFacts } from './journal-row-table'

type Request = { item: AgentJournalRenderItem; open: JournalRestFacts['openTurn'] }

/** A compact index of canonical requests, including finished heads that supersede older cuts. */
export class JournalRestProjection {
  private requests = new Map<string, Request>()
  private clears = new Map<string, number>()
  private users = new Map<string, Set<string>>()
  private latest: Request | undefined
  revision = 0
  private dirty = false
  private floor = 0

  fork(): JournalRestProjection {
    const staged = new JournalRestProjection()
    staged.requests = new JournalMutationMap(this.requests)
    staged.clears = new JournalMutationMap(this.clears)
    staged.users = new JournalMutationMap(this.users, (value) => new Set(value))
    staged.dirty = this.dirty
    staged.revision = this.revision
    staged.latest = this.latest
    staged.floor = this.floor
    return staged
  }

  fact(): JournalRestFacts['openTurn'] {
    if (this.dirty) {
      this.latest = undefined
      for (const candidate of this.requests.values()) {
        if (!this.latest || compareAgentJournalItems(candidate.item, this.latest.item) > 0) {
          this.latest = candidate
        }
      }
      this.dirty = false
    }
    return this.latest && this.latest.item.sequence > this.floor ? this.latest.open : null
  }

  observe(state: JournalReducerState, itemId: string): void {
    const item = state.items.get(itemId)
    const wasClear = this.clears.delete(itemId)
    if (item && isAgentSessionContextClear(item.body)) {
      this.clears.set(itemId, item.sequence)
      this.floor = Math.max(this.floor, item.sequence)
    } else if (wasClear) {
      this.floor = Math.max(0, ...this.clears.values())
    }
    const turn = readAgentJournalTurn(item?.body)
    const identity = parseAgentJournalItemKey(itemId)
    const submission =
      identity?.provider === 'orca' ? state.submissions.get(identity.clientMessageId) : undefined
    const command = turn?.userItemId ? state.items.get(turn.userItemId) : undefined
    const request = item
      ? latestStructuredAgentSessionRequest(
          command ? [command, item] : [item],
          submission && (this.floor === 0 || (submission.acceptedSequence ?? 0) > this.floor)
            ? [submission]
            : []
        )
      : null
    const previous = this.requests.get(itemId)
    if (previous || request || wasClear || (item && isAgentSessionContextClear(item.body))) {
      this.revision++
    }
    const previousUser = readAgentJournalTurn(previous?.item.body)?.userItemId
    if (previousUser) {
      this.users.get(previousUser)?.delete(itemId)
    }
    if (turn?.userItemId) {
      const linked = this.users.get(turn.userItemId) ?? new Set<string>()
      linked.add(itemId)
      this.users.set(turn.userItemId, linked)
    }
    if (item && request) {
      const cut =
        request.kind === 'turn' &&
        (request.turnState !== 'completed' || request.outcome === 'cancellation')
      const next = {
        item,
        open: cut
          ? { itemId, since: turn?.startedAt ?? turn?.requestedAt ?? item.observedAt }
          : null
      }
      this.requests.set(itemId, next)
      if (
        !this.latest ||
        this.latest.item.itemId === itemId ||
        compareAgentJournalItems(item, this.latest.item) > 0
      ) {
        this.latest = next
      }
    } else {
      this.requests.delete(itemId)
      if (this.latest?.item.itemId === itemId) {
        this.dirty = true
      }
    }
    // Command identity is resolved by the same selector as the sidebar, including late imports.
    for (const linked of turn ? [] : [...(this.users.get(itemId) ?? [])]) {
      if (linked !== itemId) {
        this.observe(state, linked)
      }
    }
  }
}
