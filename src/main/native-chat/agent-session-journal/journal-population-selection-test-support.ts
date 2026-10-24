import { serialize } from 'node:v8'
import { expect } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
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
