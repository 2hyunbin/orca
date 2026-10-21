// Which replayed turns a chat already holds, from saved journal facts only. A turn is the chat's
// own when its row is under the agent's turn id (Grok echoes the id Orca sent), when any agent
// message or tool call of it is a row the chat streamed into a turn of its own, or when the chat
// was adopted from a transcript holding it. A turn an earlier catch-up added is held under the
// agent's id and is only extended. Only a turn nothing proves is matched by the text of a send of
// the chat's own, between the turns proven around it: OpenCode never tells a client the id it
// gives a person's message, so a send that failed before any reply has nothing else to match.

import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { isProviderTimelineTurnInNamespace } from '../native-chat/agent-session-timeline/provider-timeline-identity'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import { AcpHistoryJournalOverlay } from './acp-history-journal-overlay'
import type { AcpIdentifiedHistoryTurn } from './acp-history-replay'
import { emptyJournal, translateHistoryTurn, type AcpHistoryScope } from './acp-history-translation'

/** The importers' spellings of an OpenCode message id: 1.x raw, 2.x prefixed, split rows suffixed. */
const ADOPTED_OPENCODE_PREFIXES = ['', 'opencode:']
const ADOPTED_OPENCODE_SUFFIXES = ['', ':reasoning', ':omission']

/** The saved rows a match reads; both the bound journal and its history view offer them. */
export type AcpHistoryReadJournal = Pick<
  StructuredAgentSessionTransitionJournal,
  'visitItems' | 'item'
>

/** A turn of the chat's own: its row, and the text of the send that opened it. */
export type AcpNativeTurn = { itemId: string; text: string }

export type AcpHistoryTurnMatch = {
  /** The chat's own turns, in journal order. */
  natives: AcpNativeTurn[]
  /** Replayed turns the chat holds as its own, or as an earlier catch-up's. */
  kind: Map<string, 'native' | 'imported'>
  /** Each replayed turn of the chat's own, by its index in `natives` when it has one. */
  matched: Map<string, number>
}

export function matchAcpHistoryTurns(
  scope: AcpHistoryScope,
  journal: StructuredAgentSessionTransitionJournal,
  turns: readonly AcpIdentifiedHistoryTurn[],
  turnRowKey: (turn: string) => string,
  importedAt: number | null
): AcpHistoryTurnMatch {
  const adopted = adoptedRecordIds(scope, journal)
  // Rows adopted from a transcript name no Grok turn: without the adoption's time, nothing is safe.
  if (scope.identity === 'prompt-id' && adopted.size > 0 && importedAt === null) {
    throw new Error('no-legacy-origin')
  }
  const natives = acpNativeTurns(scope, journal)
  const nativeIndex = new Map(natives.map((native, index) => [native.itemId, index]))
  const kind = new Map<string, 'native' | 'imported'>()
  const matched = new Map<string, number>()
  for (const turn of turns) {
    const held = journal.item(turnRowKey(turn.turn))
    const native = held
      ? nativeIndex.get(held.itemId)
      : provenNative(scope, journal, turn, nativeIndex)
    if (native !== undefined) {
      kind.set(turn.turn, 'native')
      matched.set(turn.turn, native)
    } else if (held) {
      kind.set(turn.turn, 'imported')
    } else if (
      turn.messageIds.some((id) => adoptedSpellings(id).some((spelled) => adopted.has(spelled))) ||
      (importedAt !== null && turn.startedAt !== null && turn.startedAt <= importedAt)
    ) {
      kind.set(turn.turn, 'native')
    }
  }
  claimUnprovenSends(turns, natives, kind, matched)
  return { natives, kind, matched }
}

/** The chat's own turns in this conversation, in journal order: each row a send of Orca's opened. */
export function acpNativeTurns(
  scope: AcpHistoryScope,
  journal: AcpHistoryReadJournal
): AcpNativeTurn[] {
  const turns: (AcpNativeTurn & { sequence: number })[] = []
  journal.visitItems((itemId, sequence, body) => {
    const turn = readAgentJournalTurn(body)
    const identity = parseAgentJournalItemKey(itemId)
    if (
      turn?.userItemId &&
      parseAgentJournalItemKey(turn.userItemId)?.provider === 'orca' &&
      identity?.provider === 'legacy' &&
      identity.sessionId === scope.sessionId &&
      isProviderTimelineTurnInNamespace(turn.turnId, scope.providerSessionId)
    ) {
      turns.push({
        itemId,
        sequence,
        text: messageText(journal.item(turn.userItemId)?.body ?? null)
      })
    }
  })
  return turns
    .toSorted((left, right) => left.sequence - right.sequence)
    .map(({ itemId, text }) => ({ itemId, text }))
}

/** The chat's own turn that holds a row this replayed turn also writes: an agent message or tool
 *  call the chat streamed itself, keyed by the agent's own id. */
function provenNative(
  scope: AcpHistoryScope,
  journal: StructuredAgentSessionTransitionJournal,
  turn: AcpIdentifiedHistoryTurn,
  nativeIndex: ReadonlyMap<string, number>
): number | undefined {
  // Against an empty journal every row of the turn is written, so none the chat holds is skipped.
  const probe = new AcpHistoryJournalOverlay(emptyJournal(journal.epoch))
  translateHistoryTurn(scope, probe, turn)
  for (const itemId of probe.touched()) {
    const held = journal.item(itemId)?.turnScope
    const native = held?.kind === 'turn' ? nativeIndex.get(held.turnItemId) : undefined
    if (native !== undefined) {
      return native
    }
  }
  return undefined
}

/** Between the turns proven around an unproven one, the first unmatched send of the chat's own
 *  with the same text is that turn. Two sends with the same text and no proof in the same gap,
 *  one in the chat and one elsewhere, show as one. */
function claimUnprovenSends(
  turns: readonly AcpIdentifiedHistoryTurn[],
  natives: readonly AcpNativeTurn[],
  kind: Map<string, 'native' | 'imported'>,
  matched: Map<string, number>
): void {
  const used = new Set(matched.values())
  let floor = -1
  for (const [index, turn] of turns.entries()) {
    const proven = matched.get(turn.turn)
    if (proven !== undefined) {
      floor = proven
      continue
    }
    if (kind.has(turn.turn)) {
      continue
    }
    const ceiling =
      turns
        .slice(index + 1)
        .map((later) => matched.get(later.turn))
        .find((later) => later !== undefined) ?? natives.length
    const text = blocksText(turn.user)
    for (let candidate = floor + 1; candidate < ceiling; candidate++) {
      if (!used.has(candidate) && natives[candidate]?.text === text) {
        used.add(candidate)
        kind.set(turn.turn, 'native')
        matched.set(turn.turn, candidate)
        floor = candidate
        break
      }
    }
  }
}

/** Legacy rows a transcript adoption wrote for this provider session, by record id. */
function adoptedRecordIds(scope: AcpHistoryScope, journal: AcpHistoryReadJournal): Set<string> {
  const ids = new Set<string>()
  journal.visitItems((itemId) => {
    const identity = parseAgentJournalItemKey(itemId)
    if (
      identity?.provider === 'legacy' &&
      identity.agent === scope.agent &&
      identity.sessionId === scope.providerSessionId
    ) {
      ids.add(identity.recordId)
    }
  })
  return ids
}

function adoptedSpellings(messageId: string): string[] {
  return ADOPTED_OPENCODE_PREFIXES.flatMap((prefix) =>
    ADOPTED_OPENCODE_SUFFIXES.map((suffix) => `${prefix}${messageId}${suffix}`)
  )
}

function messageText(body: AgentJournalItemBody | null): string {
  return body?.kind === 'message' ? blocksText(body.blocks) : ''
}

function blocksText(blocks: readonly NativeChatBlock[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
}
