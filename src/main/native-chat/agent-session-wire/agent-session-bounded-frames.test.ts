// The bounded-frame invariant: no frame the host emits to a `boundedFrames` subscriber is larger
// than a phone's bridge frame, whatever the chat holds. Each case below is a worst case for one
// thing a frame can carry; the last puts them all in one chat.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionBackgroundTaskState,
  AgentSessionQueuedMessage,
  AgentSessionSlashCommand,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../shared/mobile-bridge-frame-bytes'
import { diffFromToolCall } from '../../../shared/native-chat-diff'
import { MAX_TOOL_DETAIL_LENGTH } from '../../../shared/native-chat-tool-summary'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { BOUNDED_FRAME_ROW_BYTES, boundedFrameItem } from './agent-session-bounded-frame-item'
import { jsonBytes } from './json-string-shortening'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import type { QueuePublication } from './structured-agent-session-queued-publication'

// Longest id a client may name a session by, so the ids every frame repeats are at their widest.
const SESSION = `s${'x'.repeat(511)}`
// Escaped (6 bytes), multi-byte (3 bytes) and astral (4 bytes) text, so a budget counted in
// characters rather than serialized bytes would overflow.
const WIDE_TEXT = '\u0001한😀'

let root: string
let journal: AgentSessionJournal
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-bounded-frames-'))
  journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: root
  })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

let ordinal = 0
function identity(): AgentJournalItemIdentity {
  ordinal += 1
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

async function append(body: AgentJournalItemBody): Promise<void> {
  await journal.appendItem(identity(), body, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
}

const message = (text: string): AgentJournalItemBody => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text }]
})

const output = (head: string) => ({
  head,
  byteLength: 40 * 1024 * 1024,
  digest: 'f'.repeat(64),
  truncated: true
})

/** The frame a phone's bridge carries for `payload`: its envelope around the event. */
function bridgeFrameBytes(payload: AgentSessionSubscribeEvent): number {
  return jsonBytes({ v: 1, type: 'event', id: crypto.randomUUID(), seq: 2 ** 31, payload })
}

function rendered(item: Partial<AgentJournalRenderItem> & { body: AgentJournalItemBody }) {
  return { itemId: 'item-1', revision: 1, sequence: 1, observedAt: 1, ...item }
}

describe('a bounded row', () => {
  it('never weighs more than its share of a page, whatever its fields hold', () => {
    const rows = [
      rendered({ body: message(WIDE_TEXT.repeat(400_000)) }),
      rendered({
        body: {
          kind: 'tool-call',
          name: 'Write',
          state: 'completed',
          input: { file_path: '/repo/a.ts', content: WIDE_TEXT.repeat(400_000) },
          output: output(WIDE_TEXT.repeat(4_000))
        }
      }),
      // Too many short strings to shorten: the row becomes the too-large marker.
      rendered({
        body: {
          kind: 'question',
          question: 'Pick one',
          options: Array.from({ length: 20_000 }, (_, index) => ({ id: `o${index}`, label: 'x' })),
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        }
      }),
      // Identifiers are never shortened, so they are what the marker must bound itself.
      rendered({
        itemId: 'i'.repeat(5 * 1024 * 1024),
        agentId: 'a'.repeat(5 * 1024 * 1024),
        parentAgentId: 'p'.repeat(5 * 1024 * 1024),
        providerParentRef: 'r'.repeat(5 * 1024 * 1024),
        turnScope: { kind: 'turn', turnItemId: 't'.repeat(5 * 1024 * 1024) },
        body: message('short')
      })
    ]
    for (const row of rows) {
      expect(jsonBytes(boundedFrameItem(row))).toBeLessThanOrEqual(BOUNDED_FRAME_ROW_BYTES)
    }
  })

  it('keeps what the phone draws of a tool call, and says what it left out', () => {
    const text = 'line\n'.repeat(4_000)
    const diff = `@@ -1 +1 @@\n${'-old\n+new\n'.repeat(1_000)}`
    const input = { file_path: '/repo/a.ts', old_string: 'a\n'.repeat(20_000), new_string: 'b' }
    const call = (head: string): AgentJournalRenderItem =>
      rendered({
        body: { kind: 'tool-call', name: 'Edit', state: 'completed', input, output: output(head) }
      })
    const plain = boundedFrameItem(call(text)).body
    const asDiff = boundedFrameItem(call(diff)).body
    if (plain.kind !== 'tool-call' || asDiff.kind !== 'tool-call') {
      throw new Error('expected tool calls')
    }
    expect(plain.output).toMatchObject({
      head: text.slice(0, MAX_TOOL_DETAIL_LENGTH),
      truncated: true
    })
    expect(asDiff.output?.head).toBe(diff)
    // The edit's diff view still reads its full length, and still ends in its truncation line.
    expect(diffFromToolCall('Edit', plain.input, 240)).toEqual(diffFromToolCall('Edit', input, 240))
  })

  it('is the stored row when nothing in it is past what the phone draws', () => {
    const row = rendered({ body: message('hello') })
    expect(boundedFrameItem(row)).toBe(row)
  })
})

describe('frames to a bounded-frame subscriber', () => {
  function largeQueue(): QueuePublication {
    // What an older build admitted under its 1 MiB bound.
    const queuedMessages: AgentSessionQueuedMessage[] = Array.from({ length: 40 }, (_, index) => ({
      messageId: `draft-${index}`,
      position: index,
      state: 'waiting',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: WIDE_TEXT.repeat(4_000) }]
      }
    }))
    return { queuedMessages, queuePause: null, nextQueuedMessageId: 'draft-0' }
  }

  const largeRoster: AgentSessionBackgroundTaskState = {
    state: 'monitoring',
    tasks: Array.from({ length: 2_000 }, (_, index) => ({
      id: `task-${index}`,
      kind: 'command',
      description: WIDE_TEXT.repeat(200)
    }))
  }

  const largeCommands: AgentSessionSlashCommand[] = Array.from({ length: 20_000 }, (_, index) => ({
    name: `command-${index}`,
    kind: 'command',
    description: WIDE_TEXT.repeat(50)
  }))

  async function fillChat(): Promise<void> {
    for (let index = 0; index < 30; index += 1) {
      await append(message(WIDE_TEXT.repeat(30_000)))
      await append({
        kind: 'tool-call',
        name: 'Bash',
        state: 'completed',
        input: { command: WIDE_TEXT.repeat(3_000) },
        output: output(WIDE_TEXT.repeat(4_000))
      })
    }
  }

  it('each fit a phone bridge frame, from the opening snapshot through catch-up and live rows', async () => {
    await fillChat()
    const queue = largeQueue()
    const subscribers = new AgentSessionSubscribers({
      readQueuePublication: () => queue,
      readBackgroundTasks: () => largeRoster,
      readCommands: () => largeCommands
    })
    const frames: AgentSessionSubscribeEvent[] = []
    const emit = (event: AgentSessionSubscribeEvent): void => {
      frames.push(event)
    }
    subscribers.open({
      id: 'opening',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit,
      boundedFrames: true
    })
    subscribers.open({
      id: 'catch-up',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit,
      cursor: { epoch: journal.epoch, sequence: 0 },
      boundedFrames: true
    })
    await fillChat()
    subscribers.publish(SESSION, journal, { turnId: 't'.repeat(100_000), text: 'working' })
    subscribers.snapshot(SESSION, journal, 1)

    expect(frames.length).toBeGreaterThan(4)
    for (const frame of frames) {
      expect(bridgeFrameBytes(frame)).toBeLessThanOrEqual(MOBILE_BRIDGE_MAX_FRAME_BYTES)
      expect(frame).not.toHaveProperty('commands')
    }
    // The side lists still arrive, each in a frame of its own.
    const cards = frames.flatMap((frame) =>
      frame.type === 'batch' && frame.queuedMessages ? [frame.queuedMessages] : []
    )
    expect(cards.at(-1)).toHaveLength(queue.queuedMessages.length)
    expect(cards.at(-1)?.every((card) => card.truncated !== undefined)).toBe(true)
    expect(frames.some((frame) => frame.type === 'batch' && frame.backgroundTasks)).toBe(true)
  })

  it('fit even a queue an older build let grow past what previews can shrink', async () => {
    // Too many cards to fit as previews: the ones sent first are listed.
    const queuedMessages: AgentSessionQueuedMessage[] = Array.from(
      { length: 20_000 },
      (_, index) => ({
        messageId: `draft-${index}`,
        position: index,
        state: 'waiting',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'ok' }] }
      })
    )
    const frames: AgentSessionSubscribeEvent[] = []
    new AgentSessionSubscribers({
      readQueuePublication: () => ({ queuedMessages, queuePause: null, nextQueuedMessageId: null })
    }).open({
      id: 'phone',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (event) => frames.push(event),
      boundedFrames: true
    })
    for (const frame of frames) {
      expect(bridgeFrameBytes(frame)).toBeLessThanOrEqual(MOBILE_BRIDGE_MAX_FRAME_BYTES)
    }
    const listed = frames.flatMap((frame) =>
      frame.type === 'batch' && frame.queuedMessages ? frame.queuedMessages : []
    )
    expect(listed.length).toBeGreaterThan(0)
    expect(listed.map((card) => card.messageId)).toEqual(
      queuedMessages.slice(0, listed.length).map((card) => card.messageId)
    )
  })

  it('leave out a turn record no real provider id could make too large, rather than outgrow', async () => {
    await journal.appendItem(
      identity(),
      { kind: 'turn', turnId: 'u'.repeat(100_000), state: 'running' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const frames: AgentSessionSubscribeEvent[] = []
    new AgentSessionSubscribers().open({
      id: 'phone',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (event) => frames.push(event),
      boundedFrames: true
    })
    const [snapshot] = frames
    expect(bridgeFrameBytes(snapshot!)).toBeLessThanOrEqual(MOBILE_BRIDGE_MAX_FRAME_BYTES)
    expect(snapshot?.type === 'snapshot' && snapshot.page).not.toHaveProperty('latestTurn')
  })

  it('leave every other subscriber the frames it had', async () => {
    const stored = message(WIDE_TEXT.repeat(30_000))
    await append(stored)
    const queue = largeQueue()
    const frames: AgentSessionSubscribeEvent[] = []
    const subscribers = new AgentSessionSubscribers({
      readQueuePublication: () => queue,
      readBackgroundTasks: () => largeRoster,
      readCommands: () => largeCommands
    })
    subscribers.open({
      id: 'desktop',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (event) => frames.push(event)
    })
    await append(stored)
    subscribers.publish(SESSION, journal)

    expect(frames).toHaveLength(2)
    expect(frames[0]).toMatchObject({
      type: 'snapshot',
      commands: largeCommands,
      queuedMessages: queue.queuedMessages,
      backgroundTasks: largeRoster
    })
    // Rows as stored, whole.
    for (const frame of frames) {
      const items =
        frame.type === 'snapshot'
          ? frame.page.items
          : frame.type === 'batch'
            ? frame.batch.items
            : []
      expect(items.map((item) => item.body)).toEqual(items.map(() => stored))
      expect(items.every((item) => item.truncated === undefined)).toBe(true)
    }
  })
})
