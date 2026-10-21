import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { runHistoryCatchUp } from './structured-agent-session-history-catch-up'

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
})
