// Where one `item/started` or `item/completed` notification goes: nowhere for a subagent's
// activity item, whose child draws its own row from the host's records; else the typed item
// translator or the generic fallback — and, when the item is Codex echoing a send back, the turn
// attribution that echo unlocks.

import type { CodexJournalGenericFrames } from './codex-structured-journal-generic-frames'
import type { CodexJournalItems } from './codex-structured-journal-items'
import type {
  CodexJournalTranslationAdmission,
  CodexJournalTranslatorDeps
} from './codex-structured-journal-contracts'
import type { CodexJournalTurnBoundaries } from './codex-structured-journal-translation-turn-boundaries'
import { readCodexThreadItem } from './codex-structured-item-translation'
import {
  readCodexNotificationThreadItem,
  readCodexSubagentActivity
} from './codex-subagent-activity'
import { CODEX_JOURNAL_ADMITTED } from './codex-structured-journal-contracts'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import { readRecord } from './codex-item-field-readers'
import { readCodexTurnId } from './codex-structured-thread-facts'

type ThreadItemEvent = Extract<CodexStructuredSessionEvent, { type: 'notification' }>

/** Null means no arm claimed the item; the caller falls back to a generic row. */
export type CodexThreadItemRouting = CodexJournalTranslationAdmission | null

export function createCodexThreadItemRouter(input: {
  deps: Pick<
    CodexJournalTranslatorDeps,
    'dispatchRequestOrigin' | 'onUserMessageEcho' | 'observations' | 'primaryThreadId'
  >
  items: Pick<CodexJournalItems, 'handle'>
  turnBoundaries: Pick<CodexJournalTurnBoundaries, 'attributeRequest'>
  genericFrames: Pick<CodexJournalGenericFrames, 'appendUnhandled'>
}): (event: ThreadItemEvent) => CodexThreadItemRouting {
  return (event) => {
    const subagentItem = readCodexNotificationThreadItem(event.params, readCodexThreadItem)
    if (subagentItem && readCodexSubagentActivity(subagentItem) !== null) {
      return CODEX_JOURNAL_ADMITTED
    }
    const translated = input.items.handle(event)
    if (translated.handled && translated.dispatchEcho) {
      const { clientMessageId, providerIdentity } = translated.dispatchEcho
      // Kept before attribution: a refused attribution defers this frame, never its evidence.
      input.deps.observations?.receipt(clientMessageId, providerIdentity)
      const requestOrigin = input.deps.dispatchRequestOrigin?.(clientMessageId) ?? null
      if (requestOrigin !== null && providerIdentity.provider === 'codex') {
        const attribution = input.turnBoundaries.attributeRequest({
          sessionId: event.sessionId,
          clientMessageId,
          threadId: providerIdentity.threadId,
          turnId: providerIdentity.turnId,
          requestOrigin
        })
        if (!attribution.accepted) {
          return attribution
        }
      }
      input.deps.onUserMessageEcho?.(clientMessageId, providerIdentity)
    } else if (
      event.threadId === input.deps.primaryThreadId?.() &&
      readRecord(readRecord(event.params).item).type === 'userMessage'
    ) {
      // A user item with no readable exact id may be a receipt this capture missed.
      input.deps.observations?.lose(readCodexTurnId(event.params))
    }
    return translated.handled
      ? translated.admission
      : input.genericFrames.appendUnhandled(
          `notification:${event.method}`,
          event.params,
          event.threadId
        )
  }
}
