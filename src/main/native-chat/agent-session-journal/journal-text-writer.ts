import { isDeepStrictEqual } from 'node:util'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import { journalItemRowBuilder } from './journal-row-builders'
import type { JournalRow } from './journal-row-schema'
import type { JournalItemAppendOptions } from './journal-store-contracts'
import { journalTextKey } from './journal-text-index'
import { journalTextField, withJournalText } from './journal-text-rows'

export function journalStreamedItemBuilder(
  state: () => JournalReducerState,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  options: JournalItemAppendOptions
): (seq: number, ts: number) => JournalRow {
  return (seq, ts) => {
    const admission = options.streamText
    if (!admission) {
      return journalItemRowBuilder(state, identity, body, options)(seq, ts)
    }
    const current = state()
    const itemId = agentJournalItemKey(identity)
    const previous = current.items.get(itemId)
    const oldText = previous ? journalTextField(previous.body, admission.field) : null
    const marker = current.textIndex.pieces.get(journalTextKey(itemId, admission.field))?.marker
    const matching =
      previous &&
      oldText !== null &&
      oldText.length === admission.baseLength &&
      marker &&
      !admission.replace &&
      admission.suffix.length > 0 &&
      !options.recovered &&
      options.echoOf === undefined &&
      (options.ownerFence ?? current.itemFences.get(itemId)) === current.itemFences.get(itemId) &&
      (options.executionOwner === undefined ||
        options.executionOwner === current.itemExecutionOwners.get(itemId)) &&
      isDeepStrictEqual(options.turnScope, previous.turnScope) &&
      isDeepStrictEqual(agentJournalLinkageFields(options), agentJournalLinkageFields(previous)) &&
      isDeepStrictEqual(
        withJournalText(previous.body, admission.field, ''),
        withJournalText(body, admission.field, '')
      )
    if (matching) {
      return {
        v: 5,
        kind: 'text-delta',
        epoch: current.epoch,
        seq,
        fence: options.fence,
        ts: options.observedAt ?? ts,
        itemId,
        field: admission.field,
        revision: previous.revision + 1,
        predecessor: previous.revision,
        baseLength: admission.baseLength,
        suffix: admission.suffix,
        ownerFence: current.itemFences.get(itemId),
        ...(options.executionOwner === undefined ? {} : { executionOwner: options.executionOwner }),
        turnScope: options.turnScope,
        ...agentJournalLinkageFields(options)
      }
    }
    const whole = withJournalText(body, admission.field, admission.text())
    return { ...journalItemRowBuilder(state, identity, whole, options)(seq, ts), v: 5 }
  }
}
