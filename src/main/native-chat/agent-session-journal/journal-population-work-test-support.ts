import { serialize } from 'node:v8'
import { expect } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from './journal-store'
import { populationState } from './journal-population-owner-test-support'
import { WorkBucket } from './journal-work-bucket'

const identity = (id: string) =>
  ({ provider: 'codex', threadId: 'population-thread', turnId: id, ordinal: 0 }) as const

function activeOf(projection: object): WorkBucket {
  const active: unknown = Reflect.get(projection, 'active')
  if (!(active instanceof WorkBucket)) {
    throw new Error('missing actual projection work bucket')
  }
  return active
}

/** A phase of the same real writer scenario, including its actual staged work records. */
export async function exercisePopulationWork(
  journal: AgentSessionJournal,
  count: number
): Promise<void> {
  const state = populationState(journal)
  const active = activeOf(state.rest)
  const head = active.head!
  const before = serialize(active.checkpoint())
  const staged = activeOf(state.rest.fork())
  const peer = active.entries.get(agentJournalItemKey(identity('root-1')))!
  expect(peer.item.itemId).not.toBe(head.item.itemId)
  const tie = {
    ...peer,
    item: { ...peer.item, sequence: head.item.sequence, sequenceIndex: head.item.sequenceIndex }
  }
  staged.update(peer.item.itemId, tie)
  expect(staged.head).toBe(head)
  staged.update(head.item.itemId, { ...head, fact: { ...head.fact, since: head.fact.since + 1 } })
  expect(staged.head?.fact.since).toBe(head.fact.since + 1)
  staged.update(head.item.itemId, undefined)
  expect(staged.head?.item.itemId).toBe(peer.item.itemId)
  staged.update(head.item.itemId, head)
  expect(staged.head?.item.itemId).toBe(peer.item.itemId)
  staged.update(peer.item.itemId, {
    ...tie,
    item: { ...tie.item, sequence: state.lastSequence + 1 }
  })
  expect(staged.head?.item.itemId).toBe(head.item.itemId)
  expect(serialize(active.checkpoint())).toEqual(before)
  expect(active.entries.get(peer.item.itemId)).toBe(peer)

  const raw = 'typed-source'
  const source = agentJournalSubmissionKey(raw)
  await journal.appendSubmission({
    clientMessageId: raw,
    payloadFingerprint: 'typed-source-fingerprint',
    body: { kind: 'message', role: 'user', blocks: [] },
    fence: 1,
    handoverRecorded: true
  })
  expect(active.entries.has(source)).toBe(true)
  for (let index = 0; index < count; index++) {
    await journal.appendItem(
      identity(`typed-${index}`),
      {
        kind: 'turn',
        turnId: `typed-${index}`,
        userItemId: source,
        state: 'running',
        startedAt: 701 + index
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    expect(state.selection.groups.has(`turns:${source}`)).toBe(true)
    expect(active.entries.has(source)).toBe(false)
  }
  const sourceDependency = state.selection.storage
    .map<string, string>('restDependencies')
    .get(source)
  await journal.appendItem(
    identity('typed-0'),
    {
      kind: 'turn',
      turnId: 'typed-0',
      userItemId: source,
      state: 'running',
      startedAt: 701
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  expect(state.selection.storage.map<string, string>('restDependencies').get(source)).toBe(
    sourceDependency
  )
  expect(active.entries.has(source)).toBe(false)
  for (let index = 0; index < count - 1; index++) {
    await journal.appendTombstone(identity(`typed-${index}`), { fence: 1 })
    expect(state.selection.groups.has(`turns:${source}`)).toBe(true)
    expect(active.entries.has(source)).toBe(false)
  }
  await journal.appendTombstone(identity(`typed-${count - 1}`), { fence: 1 })
  expect(state.selection.groups.has(`turns:${source}`)).toBe(false)
  expect(active.entries.has(source)).toBe(false)
  await journal.resolveDispatch({
    clientMessageId: raw,
    fence: 1,
    state: 'pending',
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  expect(active.entries.get(source)?.fact).toEqual({ itemId: source, since: 100 })
  const late = await journal.appendItem(
    identity('late-provider-root'),
    {
      kind: 'turn',
      turnId: 'late-provider-root',
      state: 'running',
      startedAt: -1000
    },
    { fence: 1, observedAt: -500 }
  )
  const lateKey = agentJournalItemKey(identity('late-provider-root'))
  expect(journal.item(lateKey)?.observedAt).toBe(-500)
  expect(journal.item(lateKey)?.sequence).toBe(late.sequence)
  expect(active.head?.fact).toEqual(head.fact)
  await journal.appendItem(
    identity('late-provider-root'),
    {
      kind: 'turn',
      turnId: 'late-provider-root',
      state: 'completed',
      outcome: 'success',
      startedAt: -1000,
      completedAt: -900
    },
    { fence: 1, observedAt: -900 }
  )
  expect(active.entries.has(lateKey)).toBe(false)
  expect(journal.requestFrontier()).toBe(lateKey)
}
