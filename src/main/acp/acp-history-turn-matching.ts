import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { isProviderTimelineTurnInNamespace } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import { isHistoricalProviderTimelineItem } from '../native-chat/agent-session-timeline/provider-timeline-history'
import type { AcpHistoryItem } from './acp-history-journal-overlay'
import type { AcpIdentifiedHistoryTurn } from './acp-history-replay'
import type { AcpHistoryScope } from './acp-history-translation'

export type AcpHistoryCandidate = { source: AcpIdentifiedHistoryTurn; items: AcpHistoryItem[] }
export type AcpHistoryReadJournal = {
  items: ReadonlyMap<string, AgentJournalRenderItem>
}
type NativeTurn = { itemId: string; sequence: number; text: string | null; output: boolean }

export function acpHistoryHasOutput(body: AgentJournalItemBody): boolean {
  return (
    body.kind !== 'turn' &&
    !(body.kind === 'message' && body.role === 'user') &&
    (body.kind !== 'message' ||
      body.blocks.some((block) => block.type !== 'text' || block.text.length > 0))
  )
}

export function acpNativeTurns(
  scope: AcpHistoryScope,
  journal: AcpHistoryReadJournal
): NativeTurn[] {
  const turns: NativeTurn[] = []
  for (const item of journal.items.values()) {
    const turn = readAgentJournalTurn(item.body)
    const identity = parseAgentJournalItemKey(item.itemId)
    if (
      turn?.userItemId &&
      parseAgentJournalItemKey(turn.userItemId)?.provider === 'orca' &&
      identity?.provider === 'legacy' &&
      identity.agent === scope.agent &&
      identity.sessionId === scope.sessionId &&
      identity.recordId === `turn-lifecycle:${turn.turnId}` &&
      isProviderTimelineTurnInNamespace(turn.turnId, scope.providerSessionId)
    ) {
      const user = journal.items.get(turn.userItemId)?.body
      turns.push({
        itemId: item.itemId,
        sequence: item.sequence,
        output: false,
        text: user?.kind === 'message' && !user.command ? promptText(user.blocks) : null
      })
    }
  }
  const byId = new Map(turns.map((turn) => [turn.itemId, turn]))
  for (const item of journal.items.values()) {
    const owner = item.turnScope?.kind === 'turn' ? byId.get(item.turnScope.turnItemId) : undefined
    if (owner && acpHistoryHasOutput(item.body)) {
      owner.output = true
    }
  }
  return turns.toSorted((a, b) => a.sequence - b.sequence)
}

/** One source index supplies both exact coverage proof and the candidate bodies to reconcile. */
export function matchAcpHistoryTurns(
  scope: AcpHistoryScope,
  journal: AcpHistoryReadJournal,
  candidates: readonly AcpHistoryCandidate[],
  importedAt: number | null,
  requests: ReadonlySet<string>,
  check: () => void
) {
  const natives = acpNativeTurns(scope, journal)
  const nativeIndex = new Map(natives.map((native, index) => [native.itemId, index]))
  const adopted = new Map<string, number>()
  for (const item of journal.items.values()) {
    const identity = parseAgentJournalItemKey(item.itemId)
    if (
      identity?.provider === 'legacy' &&
      identity.agent === scope.agent &&
      identity.sessionId === scope.providerSessionId
    ) {
      adopted.set(identity.recordId, item.sequence)
    }
  }
  if (scope.identity === 'prompt-id' && adopted.size > 0 && importedAt === null) {
    throw new Error('no-legacy-origin')
  }
  const kind = new Map<string, 'native' | 'imported' | 'adopted'>()
  const matched = new Map<string, number>()
  const boundaries = new Map<string, number>()
  const read = (key: string) => journal.items.get(key) ?? null
  for (const { source, items } of candidates) {
    check()
    const owners = new Set<number>()
    let heldTurn: AgentJournalRenderItem | undefined
    for (const candidate of items) {
      check()
      const ownKey = agentJournalItemKey(candidate.identity)
      const held = read(ownKey)
      if (candidate.body.kind === 'turn') {
        heldTurn = held ?? undefined
        const native = held && nativeIndex.get(held.itemId)
        if (native !== undefined && native !== null) {
          owners.add(native)
        }
      } else if (acpHistoryHasOutput(candidate.body) && held?.turnScope?.kind === 'turn') {
        const native = nativeIndex.get(held.turnScope.turnItemId)
        if (native !== undefined) {
          owners.add(native)
        }
      }
    }
    const native = [...owners][0]
    const historical =
      heldTurn && isHistoricalProviderTimelineItem(heldTurn, read) ? heldTurn : undefined
    if (owners.size > 1 || (historical && native !== undefined)) {
      throw new Error('conflicting-history-owners')
    }
    if (native !== undefined || (scope.identity === 'prompt-id' && requests.has(source.turn))) {
      kind.set(source.turn, 'native')
      if (native !== undefined) {
        matched.set(source.turn, native)
      }
    } else if (historical) {
      kind.set(source.turn, 'imported')
      boundaries.set(source.turn, historical.sequence)
    } else if (heldTurn) {
      throw new Error('unowned-history-turn')
    } else {
      const adoptedSequence = source.messageIds.flatMap((id) =>
        ['', 'opencode:'].flatMap((prefix) =>
          ['', ':reasoning', ':omission'].flatMap((suffix) => {
            const sequence = adopted.get(`${prefix}${id}${suffix}`)
            return sequence === undefined ? [] : [sequence]
          })
        )
      )
      if (
        adoptedSequence.length ||
        (scope.identity === 'prompt-id' &&
          importedAt !== null &&
          source.startedAt !== null &&
          source.startedAt <= importedAt)
      ) {
        kind.set(source.turn, 'adopted')
        boundaries.set(
          source.turn,
          Math.max(...(adoptedSequence.length ? adoptedSequence : [...adopted.values()]))
        )
      }
    }
  }
  if (scope.identity === 'user-message-id') {
    const used = new Set(matched.values())
    const boundary = (id: string) => {
      const at = boundaries.get(id)
      return at === undefined ? undefined : natives.filter((native) => native.sequence < at).length
    }
    let floor = -1
    for (const [index, candidate] of candidates.entries()) {
      check()
      const id = candidate.source.turn
      const exact = matched.get(id)
      const edge = boundary(id)
      if (exact !== undefined) {
        floor = exact
        continue
      }
      if (edge !== undefined) {
        floor = edge - 1
        continue
      }
      if (kind.has(id) || candidate.items.some((item) => acpHistoryHasOutput(item.body))) {
        continue
      }
      const text = candidate.source.textOnly ? promptText(candidate.source.user) : null
      if (text === null) {
        continue
      }
      const ceiling =
        candidates
          .slice(index + 1)
          .map(({ source }) => matched.get(source.turn) ?? boundary(source.turn))
          .find((value) => value !== undefined) ?? natives.length
      for (let next = floor + 1; next < ceiling; next++) {
        const native = natives[next]
        if (native && !native.output && !used.has(next) && native.text === text) {
          kind.set(id, 'native')
          matched.set(id, next)
          used.add(next)
          floor = next
          break
        }
      }
    }
  }
  return { natives, kind, matched }
}

function promptText(blocks: readonly NativeChatBlock[]): string | null {
  return blocks.every((block) => block.type === 'text')
    ? blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    : null
}
