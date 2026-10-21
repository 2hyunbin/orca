import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig
} from '../agent-session-timeline/provider-timeline-assembler-test-support'
import {
  createHistoryCatchUpBatch,
  runHistoryCatchUp
} from './structured-agent-session-history-catch-up'

afterEach(closeProviderTimelineRigs)

describe('history catch-up runner', () => {
  it('gives up at the deadline when the commit never becomes durable', async () => {
    let barriers = 0
    const journal = {
      epoch: 'epoch-1',
      item: () => null,
      itemBody: () => null,
      canonicalItemId: (key: string) => key,
      visitItems: vi.fn(),
      visitItemsWithLinkage: vi.fn(),
      receiptFor: () => null,
      submissions: () => [],
      historyOrigin: () => null
    }
    const sink: StructuredAgentSessionEventSink = {
      appendItem: vi.fn(),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      // The barrier before reading settles; the one after the commit never does.
      written: () => (barriers++ === 0 ? Promise.resolve({ ok: true }) : new Promise(() => {})),
      journalHistory: () => journal,
      journalItems: () => journal,
      tryAppendTransition: () => ({ accepted: true })
    }
    const logger = { warn: vi.fn(), error: vi.fn() }
    const started = Date.now()
    const outcome = await runHistoryCatchUp({
      agentName: 'Test',
      scope: 'test-catch-up',
      sessionId: 'session-1',
      sink,
      timeoutMs: 50,
      logger,
      readView: () => 'view',
      sameView: (a, b) => a === b,
      prepare: async () => ({ settlementId: 's', mutations: [], keys: [], reservedBytes: 1 })
    })
    expect(outcome).toBe('skipped')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(logger.warn).toHaveBeenCalledWith(
      'Test chat did not catch up on turns made outside it',
      expect.objectContaining({ reason: 'import-skipped' })
    )
  })
  it.each(['commit', 'revision-conflict', 'canonical-collision'] as const)(
    'checks revisions and canonical targets atomically: %s',
    async (scenario) => {
      const rig = await openProviderTimelineRig()
      const identity = {
        provider: 'legacy' as const,
        agent: 'grok' as const,
        sessionId: 's',
        recordId: 'held'
      }
      const added = { ...identity, recordId: 'added' }
      const key = agentJournalItemKey(identity)
      const addKey = agentJournalItemKey(added)
      const body = { kind: 'status' as const, text: 'prefix' }
      await rig.journal.appendItem(identity, body, {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      const before = rig.journal.item(key)!
      let applying = false
      const eventSink = rig.eventSink
      const sink: StructuredAgentSessionEventSink = {
        ...eventSink,
        tryAppendTransition: (transition) => {
          applying = true
          return eventSink.tryAppendTransition!({
            ...transition,
            steps: transition.steps.map((step) =>
              step.kind !== 'settlement'
                ? step
                : {
                    ...step,
                    resolve: (current) =>
                      step.resolve({
                        epoch: current.epoch,
                        item: (id) => current.item(id),
                        itemBody: (id) => current.itemBody(id),
                        visitItems: (visit) => current.visitItems(visit),
                        visitItemsWithLinkage: (visit) => current.visitItemsWithLinkage(visit),
                        canonicalItemId: (id) =>
                          scenario === 'canonical-collision' && applying
                            ? key
                            : current.canonicalItemId(id)
                      })
                  }
            )
          })
        }
      }
      const outcome = await runHistoryCatchUp({
        agentName: 'Test',
        scope: 'test',
        sessionId: 's',
        sink,
        timeoutMs: 1000,
        readView: () => 'dependencies',
        sameView: (a, b) => a === b,
        prepare: async ({ view }) => {
          view()
          const batch = createHistoryCatchUpBatch()
          batch.push({
            kind: 'item',
            identity,
            body: { ...body, text: 'full' },
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          })
          batch.push({ kind: 'item', identity: added, body, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
          if (scenario === 'revision-conflict') {
            await rig.journal.appendItem(
              identity,
              { ...body, text: 'concurrent writer' },
              { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
            )
          }
          const targets = [
            { key, canonicalItemId: key, revision: before.revision },
            { key: addKey, canonicalItemId: addKey, revision: null }
          ]
          const plan = batch.finish('test', ['epoch', 'provider'], targets)
          const changed = createHistoryCatchUpBatch()
          changed.push({
            kind: 'item',
            identity,
            body: { ...body, text: 'different full body' },
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          })
          expect(
            changed.finish('test', ['epoch', 'provider'], targets.slice(0, 1)).settlementId
          ).not.toBe(plan.settlementId)
          return plan
        }
      })
      expect(outcome).toBe(scenario === 'commit' ? 'committed' : 'skipped')
      expect(rig.journal.item(addKey) !== null).toBe(scenario === 'commit')
      expect(rig.journal.item(key)?.body).toEqual({
        ...body,
        text:
          scenario === 'commit'
            ? 'full'
            : scenario === 'revision-conflict'
              ? 'concurrent writer'
              : 'prefix'
      })
    }
  )
})
