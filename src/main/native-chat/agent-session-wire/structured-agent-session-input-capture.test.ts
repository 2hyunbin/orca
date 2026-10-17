import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { adapterFor, claudeFrame, fakeClaude, identityFor } from '../../claude/claude-structured-session-test-support'
import { closeProviderTimelineRigs, openProviderTimelineRig, SESSION } from '../agent-session-timeline/provider-timeline-assembler-test-support'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import { testEventSinkLogging } from './structured-agent-session-logger-test-support'

const options = { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
const id = (recordId: string) => ({ provider: 'legacy' as const, agent: 'grok', sessionId: SESSION, recordId })
const body = (text: string) => ({ kind: 'status' as const, text, tone: 'info' as const })
const releases: (() => void)[] = []
afterEach(async () => { releases.splice(0).forEach((release) => release()); await closeProviderTimelineRigs() })

it.each([false, true])('owns a real Claude envelope before cleanup (failed=%s)', async (failed) => {
  for (const count of [1, 1025]) {
    const rig = await openProviderTimelineRig()
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind({ journal: rig.journal, fence: 1, publish: () => {} })
    const claude = fakeClaude(), adapter = adapterFor(claude)
    await adapter.acquire({ identity: identityFor(SESSION), fence: 1, spawnToken: 'capture-test', events: deferred.sink })
    await deferred.drained()
    const gate = Promise.withResolvers<void>()
    releases.push(() => gate.resolve())
    const blocked = rig.journal.readInOrder(() => gate.promise)
    deferred.sink.appendItem(id('before'), body('before'), options)
    const before = deferred.state()
    const append = vi.spyOn(rig.journal, 'appendItem')
    const text = count === 1 ? `${'\u0001'.repeat(6 * 1024 * 1024)}MIDDLE:TAIL` : 'MIDDLE:TAIL'
    const content = Array.from({ length: count }, (_, index) => ({ type: 'tool_result', tool_use_id: `result-${index}`, content: `${text}:${index}`, is_error: failed }))
    claudeFrame(claude.connections[0], { type: 'user', uuid: 'capture-envelope', message: { role: 'user', content } })
    expect(append).toHaveBeenCalledTimes(count)
    const charged = append.mock.calls.reduce((total, [identity, value]) => total + estimateStructuredAgentSessionItemBytes(identity, value), 0)
    expect(deferred.state().queuedOperations - before.queuedOperations).toBe(1)
    expect(deferred.state().queuedBytes - before.queuedBytes).toBeGreaterThanOrEqual(charged)
    let landed = false
    if (failed) {
      await adapter.releaseAcquisition({ sessionId: SESSION })
    } else {
      claude.connections[0].handlers.onExit?.(new Error('provider exited'))
      await adapter.drainObservedExits()
    }
    const barrier = deferred.sink.written?.().then((result) => { landed = true; return result })
    await Promise.resolve()
    expect(landed).toBe(false)
    expect(append).toHaveBeenCalledTimes(count)
    gate.resolve()
    await blocked
    expect(await barrier).toEqual({ ok: true })
    await deferred.drained()
    const reopened = await rig.reopenJournal()
    expect(reopened.snapshot().items.flatMap(({ body: value }) => value.kind === 'tool-call' ? [value] : [])).toEqual(content.map((result) => expect.objectContaining({ callId: result.tool_use_id, state: failed ? 'failed' : 'completed', output: expect.objectContaining({ head: result.content, truncated: false }) })))
    deferred.close()
  }
})

it.each([false, true])('preserves journal planning, publication positions and barriers (blocked=%s)', async (blocked) => {
  const results = []
  for (const captured of [false, true]) {
    const rig = await openProviderTimelineRig()
    const publications: unknown[] = []
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind({ journal: rig.journal, fence: 1, publish: () => publications.push(rig.journal.snapshot().items.map((row) => row.body)) })
    const unused = deferred.sink.reserveInput?.()
    expect(deferred.state().queuedOperations).toBe(0)
    expect(await deferred.drained()).toEqual({ ok: true })
    unused?.cancel()
    const gate = Promise.withResolvers<void>()
    releases.push(() => gate.resolve())
    const predecessor = blocked ? rig.journal.readInOrder(() => gate.promise) : Promise.resolve()
    const expectedBytes = estimateStructuredAgentSessionItemBytes(id('a'), body('a'))
    let innerBarrier: ReturnType<NonNullable<typeof deferred.sink.written>> | undefined
    const receive = (): void => {
      deferred.sink.appendItem(id('a'), body('a'), options)
      innerBarrier = deferred.sink.written?.()
      expect(rig.journal.itemBody(agentJournalItemKey(id('a')))).toEqual(blocked ? null : body('a'))
      deferred.sink.publish({ coalescingKey: 'repeat' })
      void rig.journal.appendItem(id('host'), body('host'), { fence: 1 })
      deferred.sink.tryAppendResolvedItemAndPublish?.(id('resolved'), body('resolved'), (journal) => {
        const preceding: string[] = []
        journal.visitItems((itemId) => { preceding.push(itemId) })
        expect(preceding).toContain(agentJournalItemKey(id('host')))
        return id('resolved')
      }, options)
      deferred.sink.tryAppendTransition?.({ publish: true, lifecycle: false, steps: [{ kind: 'item', reservedBytes: estimateStructuredAgentSessionItemBytes(id('transition'), body('transition')), resolve: (journal) => {
        expect(journal.itemBody(agentJournalItemKey(id('resolved')))).toEqual(body('resolved'))
        return { identity: id('transition'), body: body('transition') }
      }, options }] })
      deferred.sink.tryAppendLifecycleBatch?.('batch', [{ kind: 'item', identity: id('life'), body: body('life'), turnScope: AGENT_JOURNAL_THREAD_SCOPE }])
      deferred.sink.appendTombstone(id('a'))
      deferred.sink.publish({ coalescingKey: 'repeat' })
      throw new Error('source callback failed after its received prefix')
    }
    expect(() => captured ? deferred.sink.reserveInput?.()?.run(receive) : receive()).toThrow('source callback failed')
    expect(deferred.state().queuedBytes).toBeGreaterThanOrEqual(expectedBytes)
    const registration = vi.spyOn(rig.journal, 'appendItem')
    deferred.sink.sealInput?.(() => deferred.sink.appendItem(id('tail'), body('tail'), options))
    expect(registration).toHaveBeenCalledTimes(1)
    gate.resolve()
    await predecessor
    expect(await innerBarrier).toEqual({ ok: true })
    expect(await deferred.drained()).toEqual({ ok: true })
    expect(deferred.state().queuedBytes).toBe(0)
    expect(deferred.state().queuedOperations).toBe(0)
    results.push({ rows: (await rig.reopenJournal()).snapshot().items.map((row) => row.body), publications })
    deferred.close()
  }
  expect(results[1]).toEqual(results[0])
})
