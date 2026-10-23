// @vitest-environment happy-dom
import {
  fixture,
  transport,
  WORKSPACE,
  TARGET,
  SCOPE,
  ReadSurface
} from './structured-attention-read-retirement.test-fixture'
import { Fragment, createElement } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { SESSION } from '../../src/main/runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import type { AgentJournalRenderItem } from '../../src/shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../src/shared/agent-session-wire'
import { agentSessionPromptAttentionKey } from '../../src/shared/agent-session-attention'
import { makeUnifiedTab } from '@/store/slices/store-test-helpers'
import { useAppStore } from '@/store'
import { StructuredAgentSessionAttentionBridge } from '@/components/native-chat/StructuredAgentSessionAttentionBridge'
import { getStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner'
import { getStructuredAgentSessionTurnCompletionFeed } from '@/runtime/structured-agent-session-turn-completion-feed'
import { countAttentionCollectionWork } from '../../src/main/runtime/attention-operation-count.test-fixture'

it.each([
  [512, 2, 2],
  [5120, 2, 2],
  [512, 20, 2],
  [512, 2, 20]
])('bounds live held-reader publication at L=%i q=%i T=%i', async (length, owed, tabs) => {
  const items: AgentJournalRenderItem[] = Array.from({ length }, (_, index) => ({
    itemId: `history-${index}`,
    revision: 1,
    sequence: index + 1,
    observedAt: index + 1,
    body:
      index === 0
        ? { kind: 'turn', turnId: 'settled', state: 'completed', outcome: 'success' }
        : { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'output' }] }
  }))
  const page = (
    start: number,
    end: number,
    direction: 'tail' | 'before'
  ): AgentSessionHistoryPage => ({
    sessionId: SESSION,
    epoch: 'journal-a',
    direction,
    items: items.slice(start, end),
    removedItemIds: [],
    submissions: [],
    window: {
      oldest: { epoch: 'journal-a', sequence: start + 1 },
      newest: { epoch: 'journal-a', sequence: end },
      nextCursor: { epoch: 'journal-a', sequence: start + 1 }
    },
    liveCursor: { epoch: 'journal-a', sequence: length },
    hasOlder: start > 0,
    hasNewer: direction === 'before'
  })
  transport.call.mockImplementation(
    async (_target, method, params: { direction: string; cursor?: { sequence: number } }) => {
      if (method !== 'agentSession.history') {
        throw new Error(`Unexpected call: ${method}`)
      }
      const request = params
      const end = request.direction === 'tail' ? length : request.cursor!.sequence - 1
      return {
        ok: true,
        page: page(Math.max(0, end - 300), end, request.direction === 'tail' ? 'tail' : 'before')
      }
    }
  )
  useAppStore.setState({
    activeWorktreeId: 'elsewhere',
    unifiedTabsByWorktree: {
      [WORKSPACE]: Array.from({ length: tabs }, (_, index) =>
        makeUnifiedTab({
          id: `scale-${index}`,
          worktreeId: WORKSPACE,
          groupId: 'group',
          contentType: 'agent-session',
          entityId: index === tabs - 1 ? 'nonmatching' : SESSION,
          agentSessionAgent: 'claude'
        })
      )
    }
  })
  Object.assign(window.api, { worktrees: { updateMeta: vi.fn().mockResolvedValue(undefined) } })
  const subscriptionsOpened = vi.spyOn(window.api.runtime, 'subscribe')
  const owner = getStructuredAgentSessionReadOwner(SESSION, TARGET)
  const observe = { callbacks: 0, roots: 0, owed: 0 }
  const originalSubscribe = owner.subscribe
  vi.spyOn(owner, 'subscribe').mockImplementation((listener) =>
    originalSubscribe(() => {
      observe.callbacks += 1
      const { counts } = countAttentionCollectionWork(
        listener,
        (array) => array === owner.getSnapshot().state.items
      )
      observe.roots += counts.callbacks
      observe.owed += counts.mapEntries
    })
  )
  const feed = getStructuredAgentSessionTurnCompletionFeed(TARGET)
  let edgeVisits = 0
  const originalEdges = feed.subscribe.bind(feed)
  vi.spyOn(feed, 'subscribe').mockImplementation((listener) =>
    originalEdges((edge) => {
      edgeVisits += 1
      listener(edge)
    })
  )
  const screen = render(
    createElement(
      Fragment,
      null,
      createElement(ReadSurface, { viewed: false }),
      createElement(StructuredAgentSessionAttentionBridge)
    )
  )
  await waitFor(() => expect(fixture.journal).toBeTypeOf('function'))
  while (owner.getSnapshot().state.hasOlder) {
    await act(async () => {
      expect(await owner.loadOlder()).toBe('applied')
    })
  }
  await waitFor(() => expect(fixture.completion).toBeTypeOf('function'))
  const publish = async (changed: AgentJournalRenderItem[], sequence: number) => {
    const emit = fixture.journal
    if (!emit) {
      throw new Error('No live history transport')
    }
    await act(async () => {
      emit({
        id: 'journal',
        ok: true,
        _meta: { runtimeId: 'attention-host' },
        result: {
          type: 'batch',
          sessionId: SESSION,
          batch: {
            cursor: { epoch: 'journal-a', sequence },
            items: changed,
            removedItemIds: [],
            submissions: []
          }
        }
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
  }
  await publish([], length)
  expect(owner.getSnapshot().current).toBe(true)
  expect(owner.getSnapshot().state.items).toHaveLength(length)
  expect(owner.getSnapshot().state.items[0]?.itemId).toBe('history-0')
  await waitFor(() => expect(fixture.completion).toBeTypeOf('function'))
  const subscriptions = transport.call.mock.calls.filter(
    ([, method]) => method === 'agentSession.history'
  ).length
  expect(subscriptions).toBeGreaterThan(0)
  Object.assign(observe, { callbacks: 0, roots: 0, owed: 0 })
  for (let revision = 2; revision <= 3; revision += 1) {
    await publish([{ ...items[length - 1]!, revision }], length + revision)
    expect(owner.getSnapshot().state.items).toHaveLength(length)
  }
  const revisions = { ...observe }
  expect(revisions.roots).toBeGreaterThan(0)
  expect(revisions.roots).toBeLessThanOrEqual(2 * length * (tabs - 1))
  expect(revisions.owed).toBe(0)
  const emitEdge = fixture.completion!
  const beforeEdges = edgeVisits
  act(() => {
    for (let index = 0; index < owed; index += 1) {
      emitEdge({
        id: 'completion',
        ok: true,
        _meta: { runtimeId: 'attention-host' },
        result: {
          type: 'prompt',
          prompt: {
            scope: SCOPE,
            sessionId: SESSION,
            promptId: `owed-${index}`,
            raisedAt: index + 1,
            journalCursor: { epoch: 'journal-a', sequence: length + 3 }
          }
        }
      })
    }
  })
  expect(edgeVisits - beforeEdges).toBe(2 * tabs * owed)
  transport.dismiss.mockClear()
  Object.assign(observe, { callbacks: 0, roots: 0, owed: 0 })
  await publish(
    [
      {
        itemId: 'later-root',
        revision: 1,
        sequence: length + 10,
        observedAt: length + 10,
        body: { kind: 'turn', turnId: 'later', state: 'running' }
      }
    ],
    length + 10
  )
  const later = { ...observe }
  expect(later.roots).toBeGreaterThan(0)
  expect(later.roots).toBeLessThanOrEqual(length * (tabs - 1))
  expect(later.owed).toBe(owed * (tabs - 1))
  const expected = Array.from({ length: owed }, (_, index) => ({
    notificationId: agentSessionPromptAttentionKey(SCOPE, SESSION, `owed-${index}`)
  }))
  expect(transport.dismiss).toHaveBeenCalledTimes(tabs - 1)
  for (const call of transport.dismiss.mock.calls) {
    expect(call[3]).toEqual(expected)
  }
  expect(
    subscriptionsOpened.mock.calls.filter(
      ([request]) => request.method === 'agentSession.subscribeTurnCompletions'
    )
  ).toHaveLength(1)
  screen.unmount()
  const after = {
    callbacks: observe.callbacks,
    edgeVisits,
    dismisses: transport.dismiss.mock.calls.length
  }
  await publish([], length + 20)
  act(() =>
    emitEdge({
      id: 'completion',
      ok: true,
      result: {
        type: 'prompt',
        prompt: {
          scope: SCOPE,
          sessionId: SESSION,
          promptId: 'after-cleanup',
          raisedAt: 100,
          journalCursor: { epoch: 'journal-a', sequence: length + 20 }
        }
      }
    })
  )
  expect(observe.callbacks).toBe(after.callbacks)
  expect(edgeVisits).toBe(after.edgeVisits)
  expect(transport.dismiss).toHaveBeenCalledTimes(after.dismisses)
  console.info('renderer-scaling', {
    length,
    owed,
    tabs,
    revisions,
    later,
    edgeVisits: 2 * tabs * owed
  })
})
