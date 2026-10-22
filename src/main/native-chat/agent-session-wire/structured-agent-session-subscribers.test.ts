import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION
} from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionStatusEvent,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import {
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES,
  serializeRemoteRuntimePayload
} from '../../../shared/remote-runtime-memory-limits'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  insertTestJournalRow
} from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { MAX_RETAINED_SESSION_ACTIVITIES } from './structured-agent-session-activity-retention'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'

import {
  readAgentSessionHydrationPage,
  readAgentSessionHistory
} from './agent-session-history-page'
import {
  getStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from '../../../renderer/src/components/native-chat/structured-agent-session-read-owner'
import { BOUNDED_FRAME_CONTENT_BUDGET_BYTES } from './agent-session-history-page-bounds'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../shared/mobile-bridge-frame-bytes'
const client = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSession: client.subscribe
}))
vi.mock('@/runtime/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: vi.fn()
}))

const SESSION = 'subscriber-session'

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-agent-subscribers-'))
})

afterEach(async () => {
  resetStructuredAgentSessionReadOwnersForTests()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('AgentSessionSubscribers', () => {
  it('carries meaningful removals across bounded catch-up through the read owner and shared replacement reducer', async () => {
    const journal = await journals.open({
      stateDirectory: join(root, 'pr-31782-catch-up'),
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      }
    })
    const receipt = { write() {}, committed() {} }
    const identity = { provider: 'orca' as const, clientMessageId: 'pr-31782-early' }
    const options = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    const early = await journal.appendItem(
      identity,
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'early' }] },
      options
    )
    const owner = getStructuredAgentSessionReadOwner(SESSION, { kind: 'local' })
    owner.publishCreated(readAgentSessionHydrationPage(journal, 1))
    let receive: (event: AgentSessionSubscribeEvent) => void = () => {
      throw new Error('subscription not opened')
    }
    client.subscribe.mockImplementation(async (_target, _params, onEvent) => {
      receive = onEvent
      return { unsubscribe() {} }
    })
    const stop = owner.activate()
    try {
      const initialBoundary = owner.getSnapshot().sourceBoundary
      const initialEpoch = journal.cursor().epoch
      const gap = async (prefix: string) => {
        for (let i = 0; i < 205; i++) {
          await journal.appendItem(
            { provider: 'orca', clientMessageId: `${prefix}-${i}` },
            { kind: 'message', role: 'user', blocks: [{ type: 'text', text: prefix }] },
            options
          )
        }
      }
      const catchUp = (type: 'snapshot' | 'reset') => {
        const events: AgentSessionSubscribeEvent[] = []
        new AgentSessionSubscribers().open({
          id: 'pr-31782-reader',
          sessionId: SESSION,
          journal,
          fence: 1,
          cursor: owner.getSnapshot().state.cursor!,
          emit(event) {
            events.push(event)
            receive(event)
          }
        })
        const frame = events.find((event) => event.type === type)
        if (frame?.type !== 'snapshot' && frame?.type !== 'reset') {
          throw new Error('expected catch-up replacement')
        }
        return frame
      }
      for (const cursor of [
        { epoch: 'wrong-epoch', sequence: 100 },
        { epoch: initialEpoch, sequence: 0 }
      ]) {
        receive({
          type: 'batch',
          sessionId: SESSION,
          fence: 1,
          queuedMessages: [],
          batch: { cursor, items: [], removedItemIds: [early.itemId], submissions: [] }
        })
        expect(owner.getSnapshot().sourceBoundary).toBe(initialBoundary)
      }
      await gap('pr-31782-append')
      catchUp('snapshot')
      expect(owner.getSnapshot().sourceBoundary).toBe(initialBoundary)
      expect(owner.getSnapshot().state.items.some((item) => item.itemId === early.itemId)).toBe(
        false
      )
      const observed = owner.getSnapshot().state.cursor!
      await gap('pr-31782-before-clear')
      await journal.context.clear(
        { operationId: 'pr-31782-peer-clear', afterFence: 1, clearedAt: 2 },
        receipt,
        'pr-31782-peer-clear'
      )
      const clear = journal.context.floor()!
      expect(clear.sequence).toBe(observed.sequence + 206)
      await gap('pr-31782-after-clear')
      const first = readAgentSessionHistory(journal, {
        sessionId: SESSION,
        direction: 'after',
        cursor: observed,
        limit: 200
      })
      expect(first.page.window.newest?.sequence).toBe(observed.sequence + 200)
      const cleared = catchUp('reset')
      expect(cleared).toMatchObject({ reset: 'cursor_compacted' })
      expect(cleared.page.epoch).toBe(initialEpoch)
      expect(cleared.page.liveCursor?.sequence).toBe(observed.sequence + 412)
      expect(cleared.page.window.oldest?.sequence).toBe(observed.sequence + 213)
      expect(cleared.page.items.some((item) => item.sequence === clear.sequence)).toBe(false)
      expect(cleared.page.removedItemIds).toEqual([])
      expect(owner.getSnapshot().sourceBoundary).not.toBe(initialBoundary)
      const coveredBoundary = owner.getSnapshot().sourceBoundary
      await gap('pr-31782-covered-clear')
      catchUp('snapshot')
      expect(owner.getSnapshot().sourceBoundary).toBe(coveredBoundary)
      await journal.appendTombstone(identity, { fence: 1 })
      await gap('pr-31782-removed')
      const removed = catchUp('reset')
      expect(removed.page.removedItemIds).toEqual([])
      expect(owner.getSnapshot().sourceBoundary).not.toBe(coveredBoundary)
      expect(owner.getSnapshot().state.epoch).toBe(initialEpoch)
      const boundary = owner.getSnapshot().sourceBoundary
      await journal.appendItem(
        identity,
        { kind: 'message', role: 'assistant', blocks: [] },
        options
      )
      await journal.appendTombstone(identity, { fence: 1 })
      await gap('pr-31782-recreated')
      await journal.appendItem(
        identity,
        {
          kind: 'message',
          role: 'assistant',
          blocks: [
            {
              type: 'subagent-group',
              groupId: 'group',
              agents: [{ id: 'helper', label: 'Helper', state: 'completed' }]
            }
          ]
        },
        options
      )
      const recreated = catchUp('reset')
      expect(owner.getSnapshot().sourceBoundary).not.toBe(boundary)
      expect(owner.getSnapshot().state.items.some((item) => item.itemId === early.itemId)).toBe(
        true
      )
      expect(owner.getSnapshot().state.subagentRoster?.has('helper')).toBe(true)
      expect(
        readAgentSessionHistory(journal, {
          sessionId: SESSION,
          direction: 'before',
          cursor: recreated.page.window.oldest!
        }).page.removedItemIds
      ).toEqual([])
    } finally {
      stop()
    }
  })

  it('bounds retained turn activity across session churn', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      stateDirectory: join(root, 'activity-churn-journal')
    })
    const subscribers = new AgentSessionSubscribers()

    for (let index = 0; index < MAX_RETAINED_SESSION_ACTIVITIES + 4; index += 1) {
      subscribers.publish(`session-${index}`, journal, { turnId: `turn-${index}`, text: 'working' })
    }

    expect(subscribers.retainedActivityCountForTests).toBe(MAX_RETAINED_SESSION_ACTIVITIES)
  })

  it('publishes the current fence when a resumed cursor is already caught up', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      stateDirectory: join(root, 'checkpoint-journal')
    })
    const events: AgentSessionSubscribeEvent[] = []

    new AgentSessionSubscribers().open({
      id: 'subscriber-1',
      sessionId: SESSION,
      journal,
      fence: 7,
      cursor: journal.cursor(),
      emit: (event) => events.push(event)
    })

    expect(events).toEqual([
      {
        type: 'batch',
        sessionId: SESSION,
        batch: {
          cursor: journal.cursor(),
          items: [],
          removedItemIds: [],
          submissions: []
        },
        fence: 7,
        hostNow: expect.any(Number),
        activity: null
      }
    ])
  })

  it('stamps the host clock once per published frame', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      stateDirectory: join(root, 'clock-journal')
    })
    let now = 1_000
    let roster: AgentSessionBackgroundTaskState | null = null
    const events: AgentSessionSubscribeEvent[] = []
    const subscribers = new AgentSessionSubscribers({
      now: () => (now += 1),
      readBackgroundTasks: () => roster
    })
    const emit = (event: AgentSessionSubscribeEvent): void => {
      events.push(event)
    }
    subscribers.open({ id: 'one', sessionId: SESSION, journal, fence: 1, emit })
    subscribers.open({ id: 'two', sessionId: SESSION, journal, fence: 1, emit })
    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'clocked' },
      { kind: 'status', text: 'Clocked' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    subscribers.publish(SESSION, journal)
    roster = {
      state: 'monitoring',
      tasks: [{ id: 'task-1', kind: 'command', description: 'run the build' }]
    }
    subscribers.republishBackgroundTasks(SESSION, 1)
    subscribers.snapshot(SESSION, journal, 1)

    expect(events.map((event) => ('hostNow' in event ? event.hostNow : null))).toEqual([
      1_001, 1_002,
      // Both subscribers of one publication read the same clock sample.
      1_003, 1_003, 1_004, 1_004, 1_005, 1_005
    ])
    expect(events.map((event) => event.type)).toEqual([
      'snapshot',
      'snapshot',
      'batch',
      'batch',
      'batch',
      'batch',
      'snapshot',
      'snapshot'
    ])
  })

  it('includes catalogs on reconnect and sends an idle checkpoint without journal work', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      stateDirectory: join(root, 'catalog-journal')
    })
    let commands = [{ name: 'first', kind: 'skill' as const }]
    const events: AgentSessionSubscribeEvent[] = []
    const subscribers = new AgentSessionSubscribers({ readCommands: () => commands })
    subscribers.open({
      id: 'one',
      sessionId: SESSION,
      journal,
      fence: 7,
      emit: (event) => events.push(event)
    })
    expect(events[0]).toMatchObject({ type: 'snapshot', commands })
    commands = [{ name: 'second', kind: 'skill' as const }]
    subscribers.publish(SESSION, journal)
    expect(events[1]).toEqual({
      type: 'batch',
      sessionId: SESSION,
      fence: 7,
      hostNow: expect.any(Number),
      commands,
      batch: { cursor: journal.cursor(), items: [], removedItemIds: [], submissions: [] }
    })
    subscribers.open({
      id: 'two',
      sessionId: SESSION,
      journal,
      cursor: journal.cursor(),
      fence: 7,
      emit: (event) => events.push(event)
    })
    expect(events[2]).toMatchObject({ type: 'batch', commands })
  })

  it('reports every content publication to the journal hook, subscribed or not', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      stateDirectory: join(root, 'hook-journal')
    })
    const published: string[] = []
    const subscribers = new AgentSessionSubscribers({
      onJournalPublished: (sessionId, published_journal) => {
        expect(published_journal).toBe(journal)
        published.push(sessionId)
      }
    })

    subscribers.publish(SESSION, journal)
    subscribers.snapshot(SESSION, journal, 1)

    expect(published).toEqual([SESSION, SESSION])
  })

  it('settles a session nobody is reading, from running to idle', async () => {
    // The defect this whole feed exists for: status used to come from a transcript reader, so a
    // session with no open pane had no reader and froze on whatever it last said. Nothing here
    // ever calls `subscribers.open`.
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      stateDirectory: join(root, 'unread-journal')
    })
    const statusFeed = new StructuredAgentSessionStatusFeed({
      logger: createStructuredAgentSessionLogger(),
      sessions: new Map([
        [
          SESSION,
          {
            journal,
            params: {
              location: {
                executionHostId: 'local',
                wslDistro: null,
                workspaceId: 'workspace-1',
                workspaceKind: 'git-worktree'
              },
              provider: 'codex'
            }
          }
        ]
      ]),
      getRecord: () => null,
      now: () => 1_000
    })
    const subscribers = new AgentSessionSubscribers({
      onJournalPublished: (sessionId, published) => statusFeed.publish(sessionId, published)
    })
    const statuses: AgentSessionStatusEvent[] = []
    statusFeed.subscribe({ id: 'session-list', emit: (event) => statuses.push(event) })
    const turn = { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 } as const

    await journal.appendItem(
      { ...turn, ordinal: 1 },
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'write a poem' }] },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.appendItem(
      turn,
      { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    subscribers.publish(SESSION, journal)

    expect(statuses.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ status: 'working', latestPrompt: 'write a poem' })
    })

    await journal.appendTombstone(turn, { fence: 1 })
    subscribers.publish(SESSION, journal)

    expect(statuses.at(-1)).toEqual({
      type: 'status',
      session: expect.objectContaining({ status: 'idle' })
    })
  })

  it('publishes background lifecycle without advancing the journal and carries its fence forward', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'claude',
        providerHandle: claudeProviderHandle('provider-1', null)
      },
      stateDirectory: join(root, 'background-journal')
    })
    let roster: AgentSessionBackgroundTaskState | null = null
    const subscribers = new AgentSessionSubscribers({ readBackgroundTasks: () => roster })
    const events: AgentSessionSubscribeEvent[] = []
    subscribers.open({
      id: 'subscriber-1',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (event) => events.push(event)
    })
    const cursor = journal.cursor()

    const backgroundTasks: AgentSessionBackgroundTaskState = {
      state: 'monitoring',
      tasks: [{ id: 'task-1', kind: 'command', description: 'run the build' }]
    }
    roster = backgroundTasks
    subscribers.republishBackgroundTasks(SESSION, 2)

    expect(journal.cursor()).toEqual(cursor)
    expect(events.at(-1)).toEqual({
      type: 'batch',
      sessionId: SESSION,
      batch: { cursor, items: [], removedItemIds: [], submissions: [] },
      fence: 2,
      hostNow: expect.any(Number),
      backgroundTasks
    })

    await journal.appendItem(
      { provider: 'orca', clientMessageId: 'after-background-fence' },
      { kind: 'status', text: 'After background state' },
      { fence: 2, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    subscribers.publish(SESSION, journal)

    expect(events.at(-1)).toMatchObject({ type: 'batch', fence: 2 })
  })

  it('publishes latest turn activity without advancing or adding journal rows', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      stateDirectory: join(root, 'activity-journal')
    })
    const subscribers = new AgentSessionSubscribers()
    const events: AgentSessionSubscribeEvent[] = []
    subscribers.open({
      id: 'subscriber-1',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (event) => events.push(event)
    })
    const cursor = journal.cursor()

    subscribers.publish(SESSION, journal, {
      turnId: 'turn-1',
      text: 'Inspecting the session wire'
    })

    expect(journal.cursor()).toEqual(cursor)
    expect(events.at(-1)).toEqual({
      type: 'batch',
      sessionId: SESSION,
      batch: { cursor, items: [], removedItemIds: [], submissions: [] },
      fence: 1,
      hostNow: expect.any(Number),
      activity: { turnId: 'turn-1', text: 'Inspecting the session wire' }
    })

    subscribers.close(SESSION, 'subscriber-1')
    subscribers.publish(SESSION, journal, null)
    subscribers.open({
      id: 'reconnected',
      sessionId: SESSION,
      journal,
      fence: 1,
      cursor,
      emit: (event) => events.push(event)
    })
    expect(journal.cursor()).toEqual(cursor)
    expect(events.at(-1)).toMatchObject({ activity: null })
  })

  it.each([false, true])('bounds legacy removal, phone=%s', async (phone) => {
    const journalDir = join(root, 'oversized-removal-journal')
    const seeded = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      stateDirectory: journalDir
    })
    // Older writers admitted oversized IDs; the phone also skips a destructive gap.
    const hugeItemId = `codex:thread-1:${'h'.repeat(phone ? BOUNDED_FRAME_CONTENT_BUDGET_BYTES - 100 : 5 * 1024 * 1024)}:1`
    const resumeCursor = seeded.cursor()
    const seq = resumeCursor.sequence
    const rows: JournalRow[] = [
      {
        kind: 'item',
        itemId: hugeItemId,
        revision: 1,
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'big' }] },
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: seeded.epoch,
        seq: seq + 1,
        fence: 1,
        ts: 2_000
      },
      {
        kind: 'tombstone',
        itemId: hugeItemId,
        revision: 2,
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: seeded.epoch,
        seq: seq + 2,
        fence: 1,
        ts: 2_001
      }
    ]
    if (phone) {
      rows.splice(
        1,
        0,
        ...Array.from({ length: 205 }, (_, index): JournalRow => ({
          ...rows[0],
          kind: 'item',
          itemId: `orca:pr-31782-gap-${index}`,
          revision: 1,
          body: { kind: 'status', text: 'Gap' },
          seq: seq + index + 2
        }))
      )
      rows.at(-1)!.seq = seq + 207
    }
    // Staged straight into the session database, exactly as a previous writer
    // would have committed them.
    await seeded.close()
    const opened = openTestJournalHostDatabase(journalDir)
    try {
      opened.db.exec('BEGIN IMMEDIATE')
      for (const row of rows) {
        insertTestJournalRow(opened.db, SESSION, row)
      }
      opened.db.exec('COMMIT')
    } finally {
      opened.close()
    }
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      stateDirectory: journalDir
    })

    const subscribers = new AgentSessionSubscribers()
    const events: AgentSessionSubscribeEvent[] = []
    subscribers.open({
      id: 'subscriber-1',
      sessionId: SESSION,
      journal,
      fence: 1,
      cursor: phone ? { ...resumeCursor, sequence: seq + 1 } : resumeCursor,
      boundedFrames: phone,
      emit: (event) => events.push(event)
    })

    // Every event a remote subscriber receives must fit the outbound channel.
    for (const event of events) {
      expect(Buffer.byteLength(serializeRemoteRuntimePayload(event), 'utf8')).toBeLessThanOrEqual(
        phone ? MOBILE_BRIDGE_MAX_FRAME_BYTES : REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
      )
    }
    const reset = events.find((event) => event.type === 'reset')
    expect(reset).toMatchObject({ reset: 'cursor_compacted' })
    // Forward progress: the reset advanced the subscriber past the unsendable
    // row, so the next publish has nothing stale to re-deliver.
    const settled = events.length
    subscribers.publish(SESSION, journal)
    expect(events.slice(settled).filter((event) => event.type === 'reset')).toEqual([])
  })
})
