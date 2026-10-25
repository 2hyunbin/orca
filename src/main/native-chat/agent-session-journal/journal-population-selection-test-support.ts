import { exerciseRetainedPopulation } from './journal-population-retained-test-support'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from './journal-store'
import { deserialize, serialize } from 'node:v8'
import { expect } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import type { JournalReducerState } from './journal-reducer'
import { stageJournalMutation } from './journal-mutation-stage'

const turnIdentity = (id: string) =>
  ({ provider: 'codex', threadId: 'population-thread', turnId: id, ordinal: 0 }) as const

export function exercisePopulationSelection(state: JournalReducerState): void {
  const a = state.submissions.get('echo-0')!
  const b = state.submissions.get('echo-1')!
  const roots = serialize(Array.from(state.selection.storage.map('treeRoots')))
  const fork = stageJournalMutation(state, [])
  const address = agentJournalItemKey(turnIdentity('staged-context'))
  const setClear = (sequence: number) =>
    fork.items.set(address, {
      itemId: address,
      revision: 0,
      sequence,
      observedAt: 900,
      body: {
        kind: 'status',
        text: 'clear',
        contextClear: { operationId: 'staged-clear', afterFence: 1, clearedAt: 900 }
      }
    })
  const isolated = 'isolated-tied-fingerprint'
  fork.submissions.set('echo-0', {
    ...a,
    payloadFingerprint: isolated,
    submittedAt: 90,
    acceptedSequence: 100
  })
  fork.submissions.set('echo-1', {
    ...b,
    payloadFingerprint: isolated,
    submittedAt: 90,
    acceptedSequence: 200
  })
  expect(fork.selection.echo(isolated)).toBe('echo-0')
  setClear(150)
  expect(fork.selection.contextFloor()).toBe(150)
  expect(fork.rest.checkpoint().floor).toBe(0)
  expect(fork.selection.echo(isolated)).toBe('echo-1')
  setClear(300)
  expect(fork.selection.echo(isolated)).toBeUndefined()
  fork.items.delete(address)
  expect(fork.selection.echo(isolated)).toBe('echo-0')
  const originalOrdinal = fork.selection.storage
    .map<string, { ordinal: number }>('submissionSources')
    .get('echo-0')!.ordinal
  fork.submissions.set('echo-0', { ...a, payloadFingerprint: 'elsewhere', submittedAt: 90 })
  fork.submissions.set('echo-0', { ...a, payloadFingerprint: isolated, submittedAt: 90 })
  expect(fork.selection.echo(isolated)).toBe('echo-0')
  expect(
    fork.selection.storage.map<string, { ordinal: number }>('submissionSources').get('echo-0')
      ?.ordinal
  ).toBe(originalOrdinal)
  fork.submissions.set('echo-0', {
    ...a,
    payloadFingerprint: isolated,
    submittedAt: 90,
    dispatchState: 'rejected'
  })
  expect(fork.selection.echo(isolated)).toBe('echo-1')
  fork.submissions.set('echo-0', { ...a, payloadFingerprint: isolated, submittedAt: 90 })
  expect(fork.selection.echo(isolated)).toBe('echo-0')
  fork.submissions.delete('echo-0')
  fork.submissions.set('echo-0', { ...a, payloadFingerprint: isolated, submittedAt: 90 })
  expect(fork.selection.echo(isolated)).toBe('echo-1')
  expect(fork.selection.echo('absent-fingerprint')).toBeUndefined()
  // Original numeric comparison admits NaN clocks; a later numeric time cannot beat a first NaN.
  fork.submissions.set('echo-1', { ...b, payloadFingerprint: isolated, submittedAt: Number.NaN })
  expect(fork.selection.echo(isolated)).toBe('echo-1')
  fork.submissions.set('echo-1', { ...b, payloadFingerprint: isolated, submittedAt: Infinity })
  expect(fork.selection.echo(isolated)).toBe('echo-0')
  fork.submissions.set('echo-0', { ...a, queuedMessageId: 'tied-attempts', submittedSequence: 10 })
  fork.submissions.set('echo-1', { ...b, queuedMessageId: 'tied-attempts', submittedSequence: 10 })
  expect(fork.selection.order.maximum('attempt:tied-attempts', true)?.key).toBe('echo-0')
  fork.submissions.set('echo-0', {
    ...a,
    queuedMessageId: 'tied-attempts',
    submittedSequence: 10,
    resolvedAt: 999
  })
  expect(fork.selection.order.maximum('attempt:tied-attempts', true)?.key).toBe('echo-0')
  fork.submissions.delete('echo-1')
  fork.submissions.set('echo-1', { ...b, queuedMessageId: 'tied-attempts', submittedSequence: 10 })
  expect(fork.selection.order.maximum('attempt:tied-attempts', true)?.key).toBe('echo-1')
  expect(serialize(Array.from(state.selection.storage.map('treeRoots')))).toEqual(roots)
  expect(state.submissions.get('echo-0')).toBe(a)
}

export async function exercisePopulationEchoContext(input: {
  current: AgentSessionJournal
  state: JournalReducerState
  count: number
  fingerprint: string
  text: AgentJournalMessageItem
  turnIdentity: typeof turnIdentity
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>
}): Promise<void> {
  const { current, state, count, fingerprint, text, turnIdentity, measure } = input
  const rawBefore = state.selection.echo(fingerprint)
  expect(rawBefore).toBe(`echo-${count - 1}`)
  const sources = state.selection.storage.map<string, { ordinal: number; signature: string }>(
    'submissionSources'
  )
  const sourceBefore = sources.get(rawBefore!)!
  expect(sourceBefore).toHaveProperty('time', 101)
  const capturedSource = deserialize(serialize(sourceBefore))
  await current.resolveDispatch({
    clientMessageId: rawBefore!,
    fence: 1,
    state: 'pending',
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  expect(state.selection.echo(fingerprint)).toBe(rawBefore)
  expect(sources.get(rawBefore!)?.ordinal).toBe(sourceBefore.ordinal)
  expect(sources.get(rawBefore!)).not.toBe(sourceBefore)
  // Serialization can change numeric wire tags without changing an immutable source fact.
  expect(sourceBefore).toStrictEqual(capturedSource)
  expect(Reflect.ownKeys(sourceBefore)).toEqual(Reflect.ownKeys(capturedSource))

  await measure('context-and-echo', async () => {
    const noOutput = state.selection.tree.candidate(`echo:${fingerprint}`, rawBefore!)
    for (let index = 0; index < count; index++) {
      const clear = turnIdentity(`clear-${index}`)
      await current.appendItem(
        clear,
        {
          kind: 'status',
          text: 'clear',
          contextClear: { operationId: `clear-${index}`, afterFence: 1, clearedAt: 500 + index }
        },
        { turnScope: state.derivedTurnScope.scopeFor(text), fence: 1 }
      )
      expect(state.selection.echo(fingerprint)).toBeUndefined()
      await current.appendTombstone(clear, { fence: 1 })
      expect(state.selection.echo(fingerprint)).toBe(rawBefore)
      expect(state.selection.tree.candidate(`echo:${fingerprint}`, rawBefore!)).toEqual(noOutput)
    }
  })
  // Falling floors expose dormant echo choices, but do not resurrect removed work.
  expect(current.restFact()).toBeNull()
  await exerciseRetainedPopulation(current, count, measure)
  const blockedEcho = { ...turnIdentity('compound-blocked-echo'), ordinal: 1 }
  const liveClear = turnIdentity('compound-live-clear')
  await current.appendLifecycleBatch({
    settlementId: 'clear-before-echo',
    fence: 1,
    mutations: [
      {
        kind: 'item',
        turnScope: state.derivedTurnScope.scopeFor(text),
        identity: liveClear,
        body: {
          kind: 'status',
          text: 'clear',
          contextClear: { operationId: 'live-clear', afterFence: 1, clearedAt: 599 }
        }
      },
      { kind: 'item', turnScope: AGENT_JOURNAL_THREAD_SCOPE, identity: blockedEcho, body: text }
    ]
  })
  expect(state.aliases.has(agentJournalItemKey(blockedEcho))).toBe(false)
  expect(state.selection.contextFloor()).toBe(state.rest.checkpoint().floor)
  await current.appendTombstone(liveClear, { fence: 1 })
  const compoundEcho = { ...turnIdentity('compound-context-echo'), ordinal: 1 }
  const compoundClear = turnIdentity('compound-current-context')
  await current.appendLifecycleBatch({
    settlementId: 'two-context-source-positions',
    fence: 1,
    mutations: [
      {
        kind: 'item',
        turnScope: state.derivedTurnScope.scopeFor(text),
        identity: compoundClear,
        body: {
          kind: 'status',
          text: 'clear',
          contextClear: { operationId: 'compound-clear', afterFence: 1, clearedAt: 600 }
        }
      },
      { kind: 'tombstone', identity: compoundClear },
      { kind: 'item', turnScope: AGENT_JOURNAL_THREAD_SCOPE, identity: compoundEcho, body: text }
    ]
  })
  expect(state.aliases.get(agentJournalItemKey(compoundEcho))).toBe(
    agentJournalSubmissionKey(rawBefore!)
  )
  const nextRaw = state.selection.echo(fingerprint)!
  const echoIdentity = { ...turnIdentity('actual-echo'), ordinal: 1 }
  await current.appendItem(echoIdentity, text, { turnScope: AGENT_JOURNAL_THREAD_SCOPE, fence: 1 })
  expect(current.submission(nextRaw)?.providerItemId).toBe(agentJournalItemKey(echoIdentity))
  const explicitNull = { ...turnIdentity('explicit-null'), ordinal: 1 }
  await current.appendItem(explicitNull, text, {
    turnScope: AGENT_JOURNAL_THREAD_SCOPE,
    fence: 1,
    echoOf: null
  })
  expect(state.aliases.has(agentJournalItemKey(explicitNull))).toBe(false)
}
