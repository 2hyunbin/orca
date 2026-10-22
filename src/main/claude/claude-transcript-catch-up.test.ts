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
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle(SID, 'a1')
    } satisfies AgentSessionJournalIdentity,
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
