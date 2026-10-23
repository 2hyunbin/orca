import { Session } from 'node:inspector/promises'
import { afterEach, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import {
  AGENT,
  SESSION,
  NAMESPACE,
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  providerTurnItemId
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { catchUpAcpHistory } from './acp-history-catch-up'
import {
  acpHistoryTurns,
  type AcpIdentifiedHistoryTurn,
  type AcpLoadHistoryFrame
} from './acp-history-replay'
import { translateHistoryTurn, type AcpHistoryScope } from './acp-history-translation'
import { matchAcpHistoryTurns } from './acp-history-turn-matching'
import { acpNamedTextKey } from './acp-turn-messages'
import { OPENCODE_ACP_DIALECT } from './acp-dialects/opencode-dialect'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'

afterEach(closeProviderTimelineRigs)
const scope: AcpHistoryScope = {
  agent: AGENT,
  sessionId: SESSION,
  providerSessionId: NAMESPACE,
  identity: 'user-message-id',
  dialect: OPENCODE_ACP_DIALECT
}
const frame = (
  update: Record<string, unknown>,
  meta?: Record<string, unknown>
): AcpLoadHistoryFrame => ({
  method: 'session/update',
  params: { sessionId: NAMESPACE, update, ...(meta ? { _meta: meta } : {}) }
})
const user = (id: string, text: string) =>
  frame({ sessionUpdate: 'user_message_chunk', messageId: id, content: { type: 'text', text } })
const answer = (id: string) =>
  frame({
    sessionUpdate: 'agent_message_chunk',
    messageId: id,
    content: { type: 'text', text: 'answer' }
  })
const link = (id: string) =>
  frame({
    sessionUpdate: 'agent_message_chunk',
    messageId: id,
    content: { type: 'resource_link', uri: `file:///outside/${id}`, name: id }
  })
type Rig = Awaited<ReturnType<typeof openProviderTimelineRig>>

async function native(rig: Rig, id: string, text: string, proof?: string) {
  await rig.journal.appendSubmission({
    clientMessageId: id,
    payloadFingerprint: id,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
    fence: 1
  })
  await rig.journal.resolveDispatch({
    clientMessageId: id,
    fence: 1,
    state: 'accepted',
    providerIdentity: null
  })
  rig.assembler.apply({
    type: 'input.accepted',
    clientMessageId: id,
    requestedAt: 1000,
    join: { turn: id }
  })
  rig.assembler.apply({ type: 'turn.open', turn: id, at: 1000 })
  if (proof) {
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: acpNamedTextKey(proof, 'assistant') },
      channel: 'assistant',
      text: 'answer',
      join: { thread: NAMESPACE, turn: id }
    })
    rig.assembler.flush()
  }
  rig.assembler.apply({ type: 'turn.end', turn: id, state: 'completed', at: 1100 })
  await rig.rows()
}

async function catchUp(rig: Pick<Rig, 'eventSink'>, frames: AcpLoadHistoryFrame[]) {
  const warnings: unknown[] = []
  await catchUpAcpHistory({
    ...scope,
    frames,
    sink: rig.eventSink,
    assertCurrent: () => {},
    logger: {
      warn: (...args) => {
        warnings.push(args)
      },
      error: () => {}
    }
  })
  expect(warnings).toEqual([])
}

async function repeat(rig: Rig, frames: AcpLoadHistoryFrame[]) {
  const before = await rig.rows()
  const reopened = await rig.reopenJournal()
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal: reopened, fence: 1, publish: () => {} })
  try {
    const counts = await work(() => catchUp({ eventSink: deferred.sink }, frames))
    expect(reopened.snapshot().items).toEqual(before)
    return counts
  } finally {
    deferred.close()
    await reopened.close()
  }
}

// Count executed production blocks and built-in indexed reads, without replacing any result.
async function work(run: () => Promise<void>) {
  const inspector = new Session()
  inspector.connect()
  const counts = {
    native: 0,
    suffix: 0,
    membership: 0,
    tree: 0,
    matching: 0,
    copies: 0,
    adopted: 0
  }
  const sorted = Object.getOwnPropertyDescriptor(Array.prototype, 'toSorted')!
  const slice = Object.getOwnPropertyDescriptor(Array.prototype, 'slice')!
  const includes = Object.getOwnPropertyDescriptor(Array.prototype, 'includes')!
  const some = Object.getOwnPropertyDescriptor(Array.prototype, 'some')!
  const values = Object.getOwnPropertyDescriptor(Map.prototype, 'values')!
  const from = Object.getOwnPropertyDescriptor(Array, 'from')!
  const get = Object.getOwnPropertyDescriptor(Map.prototype, 'get')!
  const set = Object.getOwnPropertyDescriptor(Map.prototype, 'set')!
  const has = Object.getOwnPropertyDescriptor(Set.prototype, 'has')!
  await inspector.post('Profiler.enable')
  await inspector.post('Debugger.enable')
  await inspector.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
  for (const [name, descriptor, counter] of [
    ['toSorted', sorted, 'native'],
    ['slice', slice, 'suffix']
  ] as const) {
    Object.defineProperty(Array.prototype, name, {
      ...descriptor,
      value: function (this: unknown[], ...args: unknown[]) {
        const result: unknown[] = Reflect.apply(descriptor.value, this, args)
        if (
          !new Error('operation attribution').stack
            ?.split('\n')[2]
            ?.includes('acp-history-turn-matching.ts')
        ) {
          return result
        }
        return new Proxy(result, {
          get(target, key, receiver) {
            if (typeof key === 'string' && /^\d+$/.test(key)) {
              counts[counter]++
            }
            return Reflect.get(target, key, receiver)
          }
        })
      }
    })
  }
  for (const [name, descriptor, caller, counter] of [
    ['includes', includes, 'acp-history-replay.ts', 'membership'],
    ['some', some, 'structuredAgentSessionRejectedShownInPlace', 'copies']
  ] as const) {
    Object.defineProperty(Array.prototype, name, {
      ...descriptor,
      value: function (this: unknown[], ...args: unknown[]) {
        if (!new Error('operation attribution').stack?.split('\n')[2]?.includes(caller)) {
          return Reflect.apply(descriptor.value, this, args)
        }
        return Reflect.apply(
          descriptor.value,
          new Proxy(this, {
            get(target, key, receiver) {
              if (typeof key === 'string' && /^\d+$/.test(key)) {
                counts[counter]++
              }
              return Reflect.get(target, key, receiver)
            }
          }),
          args
        )
      }
    })
  }
  Object.defineProperty(Set.prototype, 'has', {
    ...has,
    value: function (this: Set<unknown>, value: unknown) {
      if (
        new Error('operation attribution').stack?.split('\n')[2]?.includes('acp-history-replay.ts')
      ) {
        counts.membership++
      }
      return Reflect.apply(has.value, this, [value])
    }
  })
  Object.defineProperty(Map.prototype, 'values', {
    ...values,
    value: function (this: Map<unknown, unknown>) {
      const iterator: IterableIterator<unknown> = Reflect.apply(values.value, this, [])
      if (
        !(new Error('operation attribution').stack ?? '').includes('acp-history-turn-matching.ts')
      ) {
        return iterator
      }
      return (function* () {
        for (const value of iterator) {
          if (typeof value === 'number') {
            counts.adopted++
          }
          yield value
        }
      })()
    }
  })
  Object.defineProperty(Array, 'from', {
    ...from,
    value: function (this: ArrayConstructor, ...args: unknown[]) {
      const result: unknown[] = Reflect.apply(from.value, this, args)
      if (
        !(new Error('operation attribution').stack ?? '').includes(
          'acp-history-ordered-availability.ts'
        )
      ) {
        return result
      }
      return new Proxy(result, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            counts.tree++
          }
          return Reflect.get(target, key, receiver)
        },
        set(target, key, value, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            counts.tree++
          }
          return Reflect.set(target, key, value, receiver)
        }
      })
    }
  })
  for (const [name, descriptor] of [
    ['get', get],
    ['set', set]
  ] as const) {
    Object.defineProperty(Map.prototype, name, {
      ...descriptor,
      value: function (this: Map<unknown, unknown>, ...args: unknown[]) {
        if (
          (new Error('operation attribution').stack ?? '').includes(
            'structuredAgentSessionRejectedShownInPlace'
          )
        ) {
          counts.copies++
        }
        return Reflect.apply(descriptor.value, this, args)
      }
    })
  }
  try {
    await run()
    const coverage = await inspector.post('Profiler.takePreciseCoverage')
    for (const script of coverage.result) {
      const path = script.url.split('?')[0]
      if (
        !/acp-history-(ordered-availability|turn-matching)\.ts$|structured-agent-session-message-projection\.ts$/.test(
          path
        )
      ) {
        continue
      }
      for (const fn of script.functions) {
        const total = fn.ranges.reduce((sum, block) => sum + block.count, 0)
        if (path.endsWith('acp-history-turn-matching.ts')) {
          counts.matching += total
        }
      }
    }
    console.info('ACP history underlying work', counts)
    return counts
  } finally {
    Object.defineProperty(Array.prototype, 'toSorted', sorted)
    Object.defineProperty(Array.prototype, 'slice', slice)
    Object.defineProperty(Array.prototype, 'includes', includes)
    Object.defineProperty(Array.prototype, 'some', some)
    Object.defineProperty(Map.prototype, 'values', values)
    Object.defineProperty(Array, 'from', from)
    Object.defineProperty(Map.prototype, 'get', get)
    Object.defineProperty(Map.prototype, 'set', set)
    Object.defineProperty(Set.prototype, 'has', has)
    await inspector.post('Profiler.disable')
    await inspector.post('Debugger.disable')
    inspector.disconnect()
  }
}

it('bounds actual first/reopened search and repeated source activation at 20 and 200', async () => {
  const populations = []
  for (const n of [20, 200]) {
    for (const k of [0, 2 * n]) {
      const rig = await openProviderTimelineRig()
      for (let i = 0; i < k; i++) {
        await native(rig, `native-${i}`, `native-${i}`)
      }
      const before = structuredClone(await rig.rows())
      const frames = Array.from({ length: n }, (_, i) => user(`outside-${i}`, `outside-${i}`))
      const first = await work(() => catchUp(rig, frames))
      const after = await rig.rows()
      expect(after.slice(0, before.length)).toEqual(before)
      expect(
        after.filter((row) => row.body.kind === 'message' && row.body.role === 'user')
      ).toHaveLength(n + k)
      expect(
        after
          .slice(before.length)
          .flatMap((row) =>
            row.body.kind === 'message' && row.body.role === 'user' ? [row.body.blocks] : []
          )
      ).toEqual(Array.from({ length: n }, (_, i) => [{ type: 'text', text: `outside-${i}` }]))
      expect(
        after.filter(
          (row) =>
            row.body.kind === 'status' && row.body.presentation?.startsWith('continued-outside')
        )
      ).toHaveLength(k === 0 ? 0 : 1)
      const unchanged = await repeat(rig, frames)
      for (const count of [first, unchanged]) {
        expect(count.suffix).toBeLessThanOrEqual(n * Math.ceil(Math.log2(n + 1)))
        expect(count.native).toBeLessThanOrEqual(2 * k + n * Math.ceil(Math.log2(k + 1)))
        expect(count.tree).toBeGreaterThan(0)
        expect(count.tree).toBeLessThan(32 * (n + k) * Math.ceil(Math.log2(n + k + 1)))
      }
      populations.push({ n, k, first, unchanged })
    }
    const rig = await openProviderTimelineRig()
    for (let i = 0; i < n; i++) {
      await native(rig, `native-${i}`, `a-${i}`)
    }
    await native(rig, 'end', 'end', 'end-proof')
    const before = structuredClone(await rig.rows())
    const frames = Array.from({ length: n }, (_, i) => [
      user(`A-${i}`, `a-${i}`),
      user(`Z-${i}`, `outside-${i}`),
      user(`A-${i}`, `a-${i}`)
    ]).flat()
    frames.push(user('E', 'end'), answer('end-proof'))
    const count = await work(() => catchUp(rig, frames))
    const after = await rig.rows()
    expect(after.slice(0, before.length)).toEqual(before)
    expect(
      after
        .slice(before.length)
        .flatMap((row) => (row.body.kind === 'message' ? [row.body.blocks] : []))
    ).toEqual(Array.from({ length: n }, (_, i) => [{ type: 'text', text: `outside-${i}` }]))
    expect(count.tree).toBeLessThan(64 * n * Math.ceil(Math.log2(n + 1)))
    populations.push({ n, k: -1, first: count, unchanged: count })
  }
  for (const small of populations.filter((entry) => entry.n === 20)) {
    const large = populations.find(
      (entry) => entry.n === 200 && (small.k === -1 ? entry.k === -1 : entry.k === small.k * 10)
    )!
    expect(large.first.matching).toBeLessThan(small.first.matching * 20)
    expect(large.unchanged.matching).toBeLessThan(small.unchanged.matching * 20)
  }
}, 120000)

it('bounds grouped IDs and rejected copies through real empty and committed views', async () => {
  for (const n of [20, 200]) {
    const rig = await openProviderTimelineRig()
    await native(rig, 'root', 'root', 'proof')
    const before = structuredClone(await rig.rows())
    // Link observations retain distinct source IDs without keeping 200 text streams open.
    const frames = [
      user('provider-root', 'root'),
      answer('proof'),
      ...Array.from({ length: n }, (_, i) => link(`part-${i}`))
    ]
    const grouped = await work(() => catchUp(rig, frames))
    expect(grouped.membership).toBeGreaterThanOrEqual(n)
    expect(grouped.membership).toBeLessThanOrEqual(n + 2)
    expect(await rig.rows()).toEqual(before)
    const parsed = acpHistoryTurns(frames, 'user-message-id')
    expect(parsed[0].messageIds).toEqual([
      'provider-root',
      'proof',
      ...Array.from({ length: n }, (_, i) => `part-${i}`)
    ])
    const rejected = await openProviderTimelineRig()
    for (let i = 0; i < n; i++) {
      await rejected.journal.appendSubmission({
        clientMessageId: `r-${i}`,
        payloadFingerprint: 'same',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'repeat' }] },
        fence: 1
      })
      await rejected.journal.resolveDispatch({
        clientMessageId: `r-${i}`,
        fence: 1,
        state: 'rejected',
        ...agentSessionFailureWords(agentSessionFailureFact('providerRejected'), {
          surface: 'rejection'
        })
      })
    }
    const seeded = structuredClone(await rejected.rows())
    const submissions = structuredClone(rejected.journal.submissions())
    const empty = await work(() => catchUp(rejected, []))
    expect(await rejected.rows()).toEqual(seeded)
    const committed = await work(() => catchUp(rejected, [user('outside', 'new')]))
    const after = await rejected.rows()
    expect(after.slice(0, seeded.length)).toEqual(seeded)
    expect(
      after
        .slice(seeded.length)
        .flatMap((row) => (row.body.kind === 'message' ? [row.body.blocks] : []))
    ).toEqual([[{ type: 'text', text: 'new' }]])
    expect(rejected.journal.submissions()).toEqual(submissions)
    expect(empty.copies).toBeGreaterThan(2 * n)
    expect(empty.copies).toBeLessThan(16 * n)
    expect(committed.copies).toBe(empty.copies * 2)
  }
}, 120000)

it('preserves regressing floors, future exact reservations, ties and non-consuming misses', async () => {
  const rig = await openProviderTimelineRig()
  for (const [id, text, proof] of [
    ['a', 'a'],
    ['b', 'b'],
    ['B', 'high'],
    ['tie', 'tie'],
    ['empty', ''],
    ['end', 'end']
  ]) {
    await native(rig, id, text, proof)
  }
  const items = new Map((await rig.rows()).map((row) => [row.itemId, row]))
  const tie = items.get(providerTurnItemId('tie'))!
  const adopted = {
    itemId: agentJournalItemKey({
      provider: 'legacy',
      agent: AGENT,
      sessionId: NAMESPACE,
      recordId: 'Q'
    }),
    sequence: tie.sequence,
    revision: 1,
    observedAt: 0,
    body: {
      kind: 'message' as const,
      role: 'assistant' as const,
      blocks: [{ type: 'text' as const, text: 'retained' }]
    }
  }
  items.set(adopted.itemId, adopted)
  const before = structuredClone([...items.values()])
  const frames = [
    user('A', 'a'),
    user('B', 'high'),
    user('A', 'a'),
    user('C', 'b'),
    user('O', 'tie'),
    user('Q', 'adopted'),
    user('P', 'tie'),
    user('U', ''),
    user('end', 'end'),
    user('B', 'high'),
    user('Z', 'end')
  ]
  const candidates = acpHistoryTurns(frames, scope.identity)
    .filter((turn): turn is AcpIdentifiedHistoryTurn => turn.turn !== null)
    .map((source) => ({ source, items: translateHistoryTurn(scope, source) }))
  const result = matchAcpHistoryTurns(scope, { items }, candidates, null, new Set(), () => {})
  expect([...result.matched]).toEqual([
    ['B', 2],
    ['end', 5],
    ['A', 0],
    ['C', 1],
    ['P', 3],
    ['U', 4]
  ])
  expect(result.kind.get('Q')).toBe('adopted')
  expect(result.kind.has('O')).toBe(false)
  expect(result.kind.has('Z')).toBe(false)
  expect([...items.values()]).toEqual(before)
})

it('keeps Grok timestamp adoption and never enumerates its unread adopted maximum', async () => {
  const grok: AcpHistoryScope = { ...scope, identity: 'prompt-id', dialect: GROK_ACP_DIALECT }
  for (const n of [20, 200]) {
    const items = new Map(
      Array.from({ length: n }, (_, i) => {
        const itemId = agentJournalItemKey({
          provider: 'legacy',
          agent: AGENT,
          sessionId: NAMESPACE,
          recordId: `old-${i}`
        })
        return [
          itemId,
          {
            itemId,
            sequence: i + 1,
            revision: 1,
            observedAt: 0,
            body: { kind: 'message' as const, role: 'assistant' as const, blocks: [] }
          }
        ] as const
      })
    )
    const frames = Array.from({ length: n }, (_, i) => [
      frame(
        {
          sessionUpdate: 'user_message_chunk',
          _meta: { promptIndex: i },
          content: { type: 'text', text: 'old' }
        },
        { agentTimestampMs: 500 }
      ),
      frame(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'resource_link', uri: 'file:///outside/old' }
        },
        { promptId: `prompt-${i}` }
      )
    ]).flat()
    const candidates = acpHistoryTurns(frames, grok.identity)
      .filter((turn): turn is AcpIdentifiedHistoryTurn => turn.turn !== null)
      .map((source) => ({ source, items: translateHistoryTurn(grok, source) }))
    const count = await work(async () => {
      const result = matchAcpHistoryTurns(grok, { items }, candidates, 500, new Set(), () => {})
      expect([...result.kind.values()]).toEqual(Array.from({ length: n }, () => 'adopted'))
    })
    expect(count.adopted).toBe(0)
    expect(
      matchAcpHistoryTurns(grok, { items }, candidates, 499, new Set(), () => {}).kind.size
    ).toBe(0)
    expect(() =>
      matchAcpHistoryTurns(grok, { items }, candidates, null, new Set(), () => {})
    ).toThrow('no-legacy-origin')
  }
})
