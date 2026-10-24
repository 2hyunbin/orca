import { expect } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionJournal } from './journal-store'
import { populationState, populationWriter } from './journal-population-owner-test-support'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'

const identity = (id: string) =>
  ({ provider: 'codex', threadId: 'population-thread', turnId: id, ordinal: 0 }) as const

/** Independent retained populations inside the one actual writer/SQLite scenario. */
export async function exerciseRetainedPopulation(
  journal: AgentSessionJournal,
  count: number,
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>
): Promise<void> {
  const state = populationState(journal)
  const writer = populationWriter(journal)
  expect(journal.restFact()).toBeNull()
  const cut = identity('retained-interrupted-cut')
  const finished = identity('retained-finished-head')
  const raw = 'older-request-source'
  const source = agentJournalSubmissionKey(raw)
  const late = identity('late-linked-request')
  const lateKey = agentJournalItemKey(late)
  await measure('request-seed', async () => {
    await journal.appendItem(
      cut,
      {
        kind: 'turn',
        turnId: 'retained-interrupted-cut',
        state: 'interrupted',
        outcome: 'cancellation',
        startedAt: 777
      },
      { fence: 1 }
    )
    expect(journal.restFact()).toEqual({ itemId: agentJournalItemKey(cut), since: 777 })
    await journal.appendItem(
      finished,
      {
        kind: 'turn',
        turnId: 'retained-finished-head',
        state: 'completed',
        outcome: 'success',
        startedAt: 888,
        completedAt: 889
      },
      { fence: 1 }
    )
    expect(journal.requestFrontier()).toBe(agentJournalItemKey(finished))
    expect(journal.restFact()).toBeNull()
    await journal.appendSubmission({
      clientMessageId: raw,
      payloadFingerprint: 'older-request-source',
      body: { kind: 'message', role: 'user', blocks: [] },
      fence: 1,
      handoverRecorded: true
    })
    const sourceSequence = journal.item(source)!.sequence
    for (let index = 0; index < count; index++) {
      await journal.appendItem(
        identity(`descending-${index}`),
        {
          kind: 'turn',
          turnId: `descending-${index}`,
          state: 'completed',
          outcome: 'success',
          startedAt: 1000 + index,
          completedAt: 2000 + index
        },
        { fence: 1 }
      )
      expect(journal.requestFrontier()).toBe(agentJournalItemKey(identity(`descending-${index}`)))
      expect(journal.restFact()).toEqual({ itemId: source, since: 100 })
    }
    await journal.appendItem(
      late,
      {
        kind: 'turn',
        turnId: 'late-linked-request',
        userItemId: source,
        state: 'running',
        startedAt: 1
      },
      { fence: 1, observedAt: -333 }
    )
    expect(journal.item(lateKey)!.sequence).toBeGreaterThan(sourceSequence)
    expect(journal.item(lateKey)!.observedAt).toBe(-333)
    expect(state.rest.checkpoint().latest?.item.itemId).toBe(
      agentJournalItemKey(identity(`descending-${count - 1}`))
    )
    expect(journal.requestFrontier()).toBe(agentJournalItemKey(identity(`descending-${count - 1}`)))
    expect(journal.restFact()).toEqual({ itemId: lateKey, since: 1 })
  })
  await measure('request-descending', async () => {
    for (let index = count - 1; index >= 0; index--) {
      await journal.appendTombstone(identity(`descending-${index}`), { fence: 1 })
      const expected =
        index === 0 ? source : agentJournalItemKey(identity(`descending-${index - 1}`))
      expect(journal.requestFrontier()).toBe(expected)
      expect(state.rest.checkpoint().latest?.item.itemId).toBe(expected)
      expect(journal.restFact()).toEqual({ itemId: lateKey, since: 1 })
    }
  })
  await measure('request-finished-rewind', async () => {
    await journal.appendItem(
      late,
      {
        kind: 'turn',
        turnId: 'late-linked-request',
        userItemId: source,
        state: 'completed',
        outcome: 'success',
        startedAt: 1,
        completedAt: 2
      },
      { fence: 1 }
    )
    expect(journal.restFact()).toBeNull()
    expect(journal.requestFrontier()).toBe(source)
    await journal.appendTombstone(late, { fence: 1 })
    await writer.enqueue((seq, ts) => ({
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: state.epoch,
      seq,
      ts,
      fence: 1,
      kind: 'tombstone',
      itemId: source,
      revision: 100,
      retireSubmission: true
    }))
    expect(journal.requestFrontier()).toBe(agentJournalItemKey(finished))
    expect(journal.restFact()).toBeNull()
    await journal.appendTombstone(finished, { fence: 1 })
    expect(journal.requestFrontier()).toBe(agentJournalItemKey(cut))
    expect(journal.restFact()).toEqual({ itemId: agentJournalItemKey(cut), since: 777 })
    await journal.appendTombstone(cut, { fence: 1 })
    expect(journal.restFact()).toBeNull()
  })

  const clear = (index: number) => identity(`retained-clear-${index}`)
  await measure('clear-seed', async () => {
    for (let index = 0; index <= count; index++) {
      await journal.appendItem(
        clear(index),
        {
          kind: 'status',
          text: 'retained clear',
          contextClear: { operationId: `retained-${index}`, afterFence: 1, clearedAt: 3000 + index }
        },
        { fence: 1 }
      )
    }
  })
  const maximum = state.selection.contextFloor()
  expect(state.rest.checkpoint().floor).toBe(maximum)
  expect(maximum).toBe(journal.item(agentJournalItemKey(clear(count)))!.sequence)
  expect(journal.restFact()).toBeNull()
  expect(journal.requestFrontier()).toBeNull()
  await measure('clear-nonmaximum', async () => {
    for (let index = 0; index < count; index++) {
      await journal.appendTombstone(clear(index), { fence: 1 })
      expect(state.selection.contextFloor()).toBe(maximum)
      expect(state.rest.checkpoint().floor).toBe(maximum)
      expect(journal.restFact()).toBeNull()
      expect(journal.requestFrontier()).toBeNull()
    }
  })
  await measure('clear-final', () => journal.appendTombstone(clear(count), { fence: 1 }))
  expect(state.selection.contextFloor()).toBe(0)
  expect(state.rest.checkpoint().floor).toBe(0)
  expect(journal.restFact()).toBeNull()
}
