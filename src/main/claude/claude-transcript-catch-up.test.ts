// Turns made outside a Claude chat, through the real path they take: the chat's own reply streamed
// by the live translator, Claude's transcript on disk → tail reader → isolated translator →
// deferred sink → on-disk journal. Row shapes follow a captured Claude Code 2.1 session.

import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import * as sessionFileResolver from '../native-chat/session-file-resolver'
import * as transcriptTail from './claude-transcript-tail'
import { catchUpClaudeTranscript } from './claude-transcript-catch-up'
import {
  isStructuredRewindTarget,
  structuredRewindCut
} from '../native-chat/agent-session-wire/structured-rewind-cut'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { readAgentSessionHistory } from '../native-chat/agent-session-wire/agent-session-history-page'
import { projectJournalBatch } from '../native-chat/agent-session-wire/agent-session-journal-batch'
import { replacePage, mergeItems } from '../../shared/structured-agent-session-history-state'
import { AgentJournalRenderItemSchema } from '../../shared/agent-session-journal-schemas'

const SESSION = 'session-claude-catch-up'
const SID = '402eff2b-84dc-4e05-8fe8-49fffb2cd3c3'

/** One content block of a saved assistant row. */
type ClaudeContentPart = { type: string } & Record<string, unknown>

const at = (n: number) => new Date(Date.UTC(2026, 9, 21, 12, 0, n)).toISOString()
const prompt = (uuid: string, parentUuid: string | null, text: string, n: number) => ({
  type: 'user',
  uuid,
  parentUuid,
  isSidechain: false,
  sessionId: SID,
  promptSource: 'cli',
  timestamp: at(n),
  message: { role: 'user', content: text }
})
const reply = (
  uuid: string,
  parentUuid: string,
  messageId: string,
  part: ClaudeContentPart,
  n: number
) => ({
  type: 'assistant',
  uuid,
  parentUuid,
  isSidechain: false,
  sessionId: SID,
  apiBlockIndex: 0,
  timestamp: at(n),
  message: { id: messageId, role: 'assistant', content: [part] }
})
const attachment = (uuid: string, parentUuid: string) => ({
  type: 'attachment',
  uuid,
  parentUuid,
  isSidechain: false,
  sessionId: SID,
  attachment: { type: 'total_tokens_reminder' }
})
const bookkeeping = [{ type: 'last-prompt', leafUuid: 'x', sessionId: SID }, { type: 'cost-state' }]

/** The chat's own turn as Claude saves it; its reply is the streamed `msg_a`. */
const chatTurn = [
  prompt('p1', null, 'ask 1', 1),
  attachment('t1', 'p1'),
  reply('a1', 't1', 'msg_a', { type: 'text', text: 'answer 1' }, 2),
  ...bookkeeping
]
/** A terminal turn on the same conversation: a prompt, a tool call and its result, then a reply. */
const outsideTurn = [
  { type: 'queue-operation', operation: 'enqueue', sessionId: SID },
  prompt('p2', 'a1', 'ask 2', 3),
  attachment('t2', 'p2'),
  reply('a2', 't2', 'msg_b', { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }, 4),
  {
    type: 'user',
    uuid: 'r2',
    parentUuid: 'a2',
    isSidechain: false,
    sessionId: SID,
    timestamp: at(5),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello' }]
    }
  },
  reply('a3', 'r2', 'msg_c', { type: 'text', text: 'answer 2' }, 6),
  ...bookkeeping
]

const journals = createTrackedJournalOpener()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

async function chat(project = '-work', cwd = '/work') {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-catch-up-'))
  const projects = join(root, 'claude-home', 'projects', project)
  await mkdir(projects, { recursive: true })
  const transcript = join(projects, `${SID}.jsonl`)
  await writeFile(transcript, '')
  const identity = {
    sessionId: SESSION,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'claude',
    providerHandle: claudeProviderHandle(SID, 'a1')
  } satisfies AgentSessionJournalIdentity
  const journal = await journals.open({
    identity,
    stateDirectory: root,
    now: () => 1_000
  })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal, fence: 1, publish: () => {} })
  cleanups.push(async () => {
    deferred.close()
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })
  const warn = vi.fn()
  return {
    journal,
    replay: () => journals.open({ identity, stateDirectory: root, now: () => 1_000 }),
    warn,
    deferred,
    write: (rows: readonly Record<string, unknown>[]) =>
      appendFile(transcript, rows.map((row) => `${JSON.stringify(row)}\n`).join('')),
    /** The chat's own turn, sent and streamed live the way the SDK reports it. */
    live: async (
      options: { interrupted?: boolean; tool?: boolean; text?: string; thinking?: string } = {}
    ) => {
      const text = options.text ?? 'answer 1'
      await journal.appendSubmission({
        clientMessageId: 'send-1',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'ask 1' }] },
        payloadFingerprint: 'send-1',
        fence: 1
      })
      await journal.resolveDispatch({
        clientMessageId: 'send-1',
        state: 'accepted',
        providerIdentity: { provider: 'claude', sessionId: SID, uuid: 'p1' },
        fence: 1
      })
      const translator = createClaudeJournalTranslator({ sink: deferred.sink })
      const frame = (message: Record<string, unknown>) =>
        translator.handle({ type: 'message', sessionId: SESSION, message, observedAt: 2_000 })
      const stream = (uuid: string, event: Record<string, unknown>) =>
        frame({ type: 'stream_event', uuid, session_id: SID, parent_tool_use_id: null, event })
      stream('s1', { type: 'message_start', message: { id: 'msg_a' } })
      stream('s2', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })
      stream('s3', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text }
      })
      if (!options.interrupted) {
        frame({
          type: 'assistant',
          uuid: 'a1',
          session_id: SID,
          parent_tool_use_id: null,
          message: { id: 'msg_a', role: 'assistant', content: [{ type: 'text', text }] }
        })
      }
      if (options.tool) {
        frame({
          type: 'assistant',
          uuid: 'call',
          session_id: SID,
          parent_tool_use_id: null,
          message: {
            id: 'call',
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'original' } }
            ]
          }
        })
      }
      if (options.thinking) {
        stream('thought-start', { type: 'message_start', message: { id: 'msg_thought' } })
        stream('thought-block', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' }
        })
        stream('thought-delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: options.thinking }
        })
      }
      if (options.interrupted) {
        translator.handle({ type: 'ended', sessionId: SESSION, reason: 'crash', observedAt: 3_000 })
      } else {
        frame({ type: 'result', subtype: 'success', session_id: SID, parent_tool_use_id: null })
      }
      translator.flush()
      translator.dispose()
      await deferred.drained()
    },
    open: async (
      leafUuid: string,
      options: Pick<
        Parameters<typeof catchUpClaudeTranscript>[0],
        'signal' | 'timeoutMs' | 'assertCurrent'
      > = {}
    ) => {
      const covered = await catchUpClaudeTranscript({
        sessionId: SESSION,
        providerSessionId: SID,
        leafUuid,
        claudeConfigDir: join(root, 'claude-home'),
        cwd,
        sink: deferred.sink,
        logger: { warn, error: vi.fn() },
        ...options
      })
      await deferred.drained()
      return covered
    },
    rows: () =>
      journal.snapshot().items.flatMap((item) => {
        const { body } = item
        if (body.kind === 'message') {
          const text = body.blocks.map((block) => (block.type === 'text' ? block.text : ''))
          return [`${body.role}:${text.join('')}`]
        }
        if (body.kind === 'tool-call') {
          return [`tool:${body.name}:${body.state}`]
        }
        return body.kind === 'status' && body.presentation ? [`(${body.presentation})`] : []
      })
  }
}

describe('Claude chat catch-up', () => {
  it.each(['a1', 'missing-parent'])(
    'keeps an unresolved queued prompt visible without inventing a turn after %s',
    async (parent) => {
      const c = await chat()
      await c.live()
      await c.journal.appendSubmission({
        clientMessageId: 'new-native-send',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'new native request' }]
        },
        payloadFingerprint: 'new-native-send',
        handoverRecorded: true,
        fence: 1
      })
      const submissions = c.journal.snapshot().submissions
      const cursor = c.journal.cursor()
      await c.write([
        ...chatTurn,
        {
          ...attachment('queued-row', parent),
          attachment: {
            type: 'queued_command',
            source_uuid: 'cmd-1',
            commandMode: 'prompt',
            origin: { kind: 'human' },
            humanTurn: true,
            prompt: 'follow up'
          }
        }
      ])
      const key = agentJournalItemKey({ provider: 'claude', sessionId: SID, uuid: 'cmd-1' })
      expect(await c.open('a1')).toBe(true)
      const held = c.journal.snapshot().items
      expect(c.rows().filter((row) => row === 'user:follow up')).toHaveLength(1)
      expect(c.journal.item(key)?.turnScope).toEqual({ kind: 'unknown' })
      expect(isStructuredRewindTarget(c.journal, key)).toBe(false)
      expect(held.filter((row) => row.body.kind === 'turn')).toHaveLength(1)
      expect(await c.open('a1')).toBe(true)
      expect(c.journal.snapshot().items).toEqual(held)
      const reopened = await c.replay()
      expect(reopened.item(key)).toEqual(c.journal.item(key))
      expect(isStructuredRewindTarget(reopened, key)).toBe(false)
      const page = readAgentSessionHistory(reopened, { sessionId: SESSION, direction: 'tail' })
      const delta = reopened.readSince(cursor)
      if (!page.ok || !delta.ok) {
        throw new Error('history unavailable')
      }
      const batch = projectJournalBatch({
        rows: delta.rows,
        snapshot: reopened.snapshot(),
        afterSequence: cursor.sequence
      })
      if (!batch.ok) {
        throw new Error('batch unavailable')
      }
      const snapshotClient = replacePage(page.page, 1)
      const liveClient = mergeItems([], batch.batch.items, [])
      expect(snapshotClient.items.find((item) => item.itemId === key)).toEqual(c.journal.item(key))
      expect(liveClient.find((item) => item.itemId === key)).toEqual(c.journal.item(key))
      // The open wire schema used by older readers preserves the new scope and message content.
      expect(
        AgentJournalRenderItemSchema.parse(JSON.parse(JSON.stringify(c.journal.item(key))))
      ).toMatchObject({ turnScope: { kind: 'unknown' }, body: { role: 'user' } })

      await c.write([
        reply('a2', 'queued-row', 'msg_b', { type: 'text', text: 'follow up answer' }, 4),
        prompt('p3', 'a2', 'next request', 5),
        reply('a3', 'p3', 'msg_c', { type: 'text', text: 'next answer' }, 6)
      ])
      expect(await c.open('a1')).toBe(true)
      const items = c.journal.snapshot().items
      expect(c.journal.item(key)).toEqual(held.find((row) => row.itemId === key))
      const resumed = items.find((row) => row.body.kind === 'turn' && row.body.turnId === 'a2')
      expect(resumed?.body).toMatchObject({ userItemId: resumed?.itemId })
      const opener = agentJournalItemKey({ provider: 'claude', sessionId: SID, uuid: 'p3' })
      expect(isStructuredRewindTarget(c.journal, opener)).toBe(true)
      expect(c.journal.snapshot().submissions).toEqual(submissions)
      expect(c.rows().filter((row) => row === 'user:follow up')).toHaveLength(1)
      expect(c.warn).not.toHaveBeenCalled()
      const cut = structuredRewindCut(c.journal, {
        itemId: opener,
        provider: 'claude',
        nativeId: SID
      })
      if (!cut) {
        throw new Error('ordinary rewind unavailable')
      }
      await c.journal.replaceEpochItems('rewind', 1, cut.kept)
      expect(c.journal.item(key)?.turnScope).toEqual({ kind: 'unknown' })
      expect((await c.replay()).item(key)?.turnScope).toEqual({ kind: 'unknown' })
    }
  )

  it('keeps new queued input in the observed outside turn without splitting its work', async () => {
    const c = await chat()
    await c.live()
    await c.write([
      ...chatTurn,
      prompt('p2', 'a1', 'outside request', 3),
      reply('a2', 'p2', 'msg_b', { type: 'text', text: 'working' }, 4),
      {
        ...attachment('queued-row', 'a2'),
        attachment: {
          type: 'queued_command',
          source_uuid: 'cmd-1',
          commandMode: 'prompt',
          origin: { kind: 'human' },
          humanTurn: true,
          prompt: 'follow up'
        }
      },
      reply('a3', 'queued-row', 'msg_c', { type: 'text', text: 'finished' }, 5)
    ])
    expect(await c.open('a1')).toBe(true)
    const key = (uuid: string) => agentJournalItemKey({ provider: 'claude', sessionId: SID, uuid })
    const queued = c.journal.item(key('cmd-1'))
    expect(queued?.turnScope).toEqual(c.journal.item(key('block:msg_b:0'))?.turnScope)
    expect(queued?.turnScope).toMatchObject({ kind: 'turn' })
    expect(c.journal.item(key('block:msg_c:0'))?.turnScope).toEqual(queued?.turnScope)
    expect(c.journal.snapshot().items.filter((row) => row.body.kind === 'turn')).toHaveLength(2)
    expect(isStructuredRewindTarget(c.journal, key('cmd-1'))).toBe(false)
    expect(isStructuredRewindTarget(c.journal, key('p2'))).toBe(true)
  })
  it.each([
    ['-work', '/work', false],
    ['-work-caf-', '/work/cafe\u0301', false],
    ['-old-work', '/moved-work', true]
  ] as const)(
    'uses the selected-home bucket, retaining moved-project fallback: %s',
    async (project, cwd, fallback) => {
      const c = await chat(project, cwd)
      await c.write([...chatTurn, ...outsideTurn])
      const resolve = vi.spyOn(sessionFileResolver, 'resolveSessionFilePath')
      expect(await c.open('a1')).toBe(true)
      expect(c.rows()).toContain('assistant:answer 2')
      expect(resolve).toHaveBeenCalledTimes(fallback ? 1 : 0)
      if (fallback) {
        expect(resolve).toHaveBeenCalledWith(
          'claude',
          SID,
          expect.objectContaining({ claudeProjectsDir: expect.any(String) }),
          expect.any(AbortSignal)
        )
      }
    }
  )

  it('completes interrupted text and a result-only tool once at their original positions', async () => {
    const c = await chat()
    await c.live({
      interrupted: true,
      tool: true,
      text: 'unfinished, differently normalized',
      thinking: 'retained thought'
    })
    const before = c.journal.snapshot().items
    const tool = before.find((item) => item.body.kind === 'tool-call')!
    const text = before.find(
      (item) => item.body.kind === 'message' && item.body.role === 'assistant'
    )!
    const turn = before.find((item) => item.body.kind === 'turn')!
    const thinking = before.find(
      (item) => item.body.kind === 'message' && item.body.role === 'reasoning'
    )!
    await c.write([
      prompt('boundary', null, 'saved before crash', 1),
      reply('a1', 'boundary', 'msg_a', { type: 'text', text: 'final answer, normalized' }, 2),
      reply('thinking-final', 'a1', 'msg_thought', { type: 'thinking', thinking: '' }, 3),
      { ...outsideTurn[4], parentUuid: 'thinking-final' }
    ])
    expect(await c.open('boundary')).toBe(true)
    const afterText = c.journal.item(text.itemId)!
    const afterTool = c.journal.item(tool.itemId)!
    expect(afterText).toMatchObject({
      sequence: text.sequence,
      turnScope: text.turnScope,
      body: { blocks: [{ type: 'text', text: 'final answer, normalized' }] }
    })
    expect(afterTool).toMatchObject({
      sequence: tool.sequence,
      turnScope: tool.turnScope,
      body: {
        name: 'Read',
        input: { path: 'original' },
        state: 'completed',
        output: { head: 'hello' }
      }
    })
    expect(c.journal.item(turn.itemId)).toEqual(turn)
    expect(c.journal.item(thinking.itemId)).toEqual(thinking)
    expect(c.rows().some((row) => row.startsWith('(continued-outside'))).toBe(false)
    const completed = c.journal.snapshot().items
    expect(await c.open('boundary')).toBe(true)
    expect(c.journal.snapshot().items).toEqual(completed)
  })

  it('does not place historical lifecycle after live work that arrives during its read', async () => {
    const c = await chat()
    await c.live()
    await c.write([...chatTurn, ...outsideTurn])
    const read = transcriptTail.readClaudeTranscriptTail
    const live = createClaudeJournalTranslator({ sink: c.deferred.sink })
    vi.spyOn(transcriptTail, 'readClaudeTranscriptTail').mockImplementationOnce(async (input) => {
      const tail = await read(input)
      live.handle({
        type: 'message',
        sessionId: SESSION,
        message: {
          type: 'stream_event',
          uuid: 'wake',
          session_id: SID,
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'live-wake' } }
        }
      })
      return tail
    })
    expect(await c.open('a1')).toBe(false)
    expect(c.rows()).not.toContain('user:ask 2')
    const running = c.journal.snapshot().items.findLast((item) => item.body.kind === 'turn')
    expect(running?.body).toMatchObject({ state: 'running' })
    live.dispose()
  })

  it('cancels fallback discovery and cannot commit a late result', async () => {
    const c = await chat('-old-work', '/new-work')
    await c.write([...chatTurn, ...outsideTurn])
    const lookup = Promise.withResolvers<string | null>()
    const resolve = vi
      .spyOn(sessionFileResolver, 'resolveSessionFilePath')
      .mockReturnValueOnce(lookup.promise)
    expect(await c.open('a1', { timeoutMs: 5 })).toBe(false)
    expect(resolve.mock.calls[0]?.[3]?.aborted).toBe(true)
    lookup.resolve(null)
    await new Promise<void>((done) => setImmediate(done))
    expect(c.rows()).toEqual([])
  })

  it('shows the turns made outside the chat once, in order, under one divider', async () => {
    const c = await chat()
    await c.live()
    await c.write(chatTurn)
    const shown = c.rows()
    expect(shown).toEqual(['user:ask 1', 'assistant:answer 1'])

    await c.open('a1')
    expect(c.rows()).toEqual(shown)

    await c.write(outsideTurn)
    await c.open('a1')
    const caughtUp = [
      ...shown,
      '(continued-outside)',
      'user:ask 2',
      'tool:Read:completed',
      'assistant:answer 2'
    ]
    expect(c.rows()).toEqual(caughtUp)
    expect(c.journal.snapshot().submissions).toHaveLength(1)

    // Opening again, or from a leaf left before the chat's own streamed turn by a crash, adds nothing.
    await c.open('a1')
    await c.open('p1')
    expect(c.rows()).toEqual(caughtUp)
    expect(c.warn).not.toHaveBeenCalled()
  })

  it('imports a later outside batch from the retained leaf without reusing its old divider', async () => {
    const c = await chat()
    await c.live()
    await c.write([...chatTurn, ...outsideTurn])
    expect(await c.open('a1')).toBe(true)
    const before = c.rows()
    await c.write([
      prompt('p3', 'a3', 'ask 3', 7),
      reply('a4', 'p3', 'msg_d', { type: 'text', text: 'answer 3' }, 8)
    ])
    expect(await c.open('a1')).toBe(true)
    expect(c.rows()).toEqual([...before, '(continued-outside)', 'user:ask 3', 'assistant:answer 3'])
    const imported = c.journal.snapshot().items
    expect(await c.open('a1')).toBe(true)
    expect(c.journal.snapshot().items).toEqual(imported)
    expect(c.warn).not.toHaveBeenCalled()
  })

  it('matches an accepted queued human prompt by its provider source UUID without settling it', async () => {
    const c = await chat()
    await c.live()
    await c.journal.appendSubmission({
      clientMessageId: 'queued-send',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'follow up' }] },
      payloadFingerprint: 'queued-send',
      handoverRecorded: true,
      fence: 1
    })
    const scope = c.journal
      .snapshot()
      .items.find(
        (item) => item.body.kind === 'message' && item.body.role === 'assistant'
      )?.turnScope
    if (!scope || scope.kind !== 'turn') {
      throw new Error('missing native turn')
    }
    await c.journal.resolveDispatch({
      clientMessageId: 'queued-send',
      state: 'pending',
      turnScope: scope,
      fence: 1
    })
    await c.journal.resolveDispatch({
      clientMessageId: 'queued-send',
      state: 'accepted',
      providerIdentity: { provider: 'claude', sessionId: SID, uuid: 'cmd-1' },
      fence: 1
    })
    const submissions = c.journal.snapshot().submissions
    await c.write([
      ...chatTurn,
      {
        ...attachment('queued-row', 'a1'),
        attachment: {
          type: 'queued_command',
          source_uuid: 'cmd-1',
          delivery_id: 'delivery-1',
          commandMode: 'prompt',
          origin: { kind: 'human' },
          humanTurn: true,
          prompt: 'follow up'
        }
      },
      reply('a2', 'queued-row', 'msg_b', { type: 'text', text: 'follow up answer' }, 3)
    ])
    expect(await c.open('a1')).toBe(true)
    expect(c.rows()).toEqual([
      'user:ask 1',
      'assistant:answer 1',
      'user:follow up',
      '(continued-outside)',
      'assistant:follow up answer'
    ])
    const imported = c.journal.snapshot().items
    expect(await c.open('a1')).toBe(true)
    expect(c.journal.snapshot().items).toEqual(imported)
    expect(c.journal.snapshot().submissions).toEqual(submissions)
    const answer = c.journal
      .snapshot()
      .items.find(
        (item) =>
          item.body.kind === 'message' &&
          item.body.role === 'assistant' &&
          item.itemId !==
            agentJournalItemKey({ provider: 'claude', sessionId: SID, uuid: 'block:msg_a:0' })
      )
    expect(answer?.turnScope).toEqual(scope)
    expect(c.journal.snapshot().items.filter((item) => item.body.kind === 'turn')).toHaveLength(1)
    expect(c.warn).not.toHaveBeenCalled()
  })

  it('marks turns that continue from an earlier message than the chat last showed', async () => {
    const c = await chat()
    await c.live()
    await c.write([
      ...chatTurn,
      prompt('p3', 'p1', 'ask 1, edited', 7),
      reply('a4', 'p3', 'msg_d', { type: 'text', text: 'answer 1, edited' }, 8)
    ])
    await c.open('a1')
    expect(c.rows().slice(2)).toEqual([
      '(continued-outside-rewound)',
      'user:ask 1, edited',
      'assistant:answer 1, edited'
    ])
  })

  it('reads an outside reply that spans many read chunks whole', async () => {
    const c = await chat()
    await c.live()
    const answer = `${'outside answer paragraph\n'.repeat(12_000)}END`
    await c.write([
      ...chatTurn,
      prompt('p5', 'a1', 'ask long', 9),
      reply('a5', 'p5', 'msg_e', { type: 'text', text: answer }, 10),
      ...bookkeeping
    ])
    await c.open('a1')
    expect(c.rows().slice(2)).toEqual([
      '(continued-outside)',
      'user:ask long',
      `assistant:${answer}`
    ])
  })

  it('opens normally when the saved leaf is not in the transcript', async () => {
    const c = await chat()
    await c.live()
    await c.write([...chatTurn, ...outsideTurn])
    await c.open('missing')
    expect(c.rows()).toEqual(['user:ask 1', 'assistant:answer 1'])
    expect(c.warn).toHaveBeenCalledWith(
      'Claude chat did not catch up on turns made outside it',
      expect.objectContaining({ reason: 'leaf-not-in-tail' })
    )
  })
})
