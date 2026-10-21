import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readFile, readdir } from 'node:fs/promises'
import { prepareOpenCodeReadableContext } from '../opencode/opencode-readable-context'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { AGENT_SESSION_HOST_STATUS_COPY } from '../../shared/agent-session-host-status-rows'
import Database from '../sqlite/sync-database'
import { opencodeMessages } from './transcript-opencode-part-blocks'
import {
  readOpenCodeTranscriptPage,
  readOpenCodeTranscriptSignal
} from './transcript-opencode-sqlite-query'
import { readOpenCodeNativeChatTranscriptFull } from './transcript-opencode'
import { subscribeOpenCodeNativeChatTranscript } from './transcript-opencode-subscribe'

vi.mock('../managed-data-accounts/service', () => ({ getManagedDataAccountService: vi.fn() }))

vi.mock('../ai-vault/session-scanner-opencode-sqlite-worker-spawn', () => ({
  readOpenCodeTranscriptSignalViaWorker: async ({
    dbPath,
    sessionId
  }: {
    dbPath: string
    sessionId: string
  }) => readOpenCodeTranscriptSignal(dbPath, sessionId),
  readOpenCodeTranscriptPageViaWorker: async (
    args: Parameters<typeof readOpenCodeTranscriptPage>[0]
  ) => readOpenCodeTranscriptPage(args)
}))

const fixtures: { db: Database.Database; root: string }[] = []
afterEach(() => {
  for (const { db, root } of fixtures.splice(0)) {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(version: 'v1' | 'v2') {
  const root = mkdtempSync(join(tmpdir(), 'orca-opencode-semantics-'))
  const path = join(root, 'opencode.db')
  const db = new Database(path)
  fixtures.push({ db, root })
  if (version === 'v1') {
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_updated INTEGER, data TEXT);
      INSERT INTO session VALUES ('session', '/work'), ('other', '/work');`)
  } else {
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT);
      CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER,
        data TEXT, time_created INTEGER, time_updated INTEGER);
      INSERT INTO session_v2 VALUES ('session', '/work'), ('other', '/work');`)
  }
  let sequence = 0
  const insert = (id: string, parts: unknown[], sessionId = 'session') => {
    sequence += 7
    if (version === 'v1') {
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
        id,
        sessionId,
        sequence,
        sequence,
        JSON.stringify({ role: 'assistant' })
      )
      parts.forEach((part, index) => {
        db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(
          `${id}:${index}`,
          id,
          sessionId,
          sequence,
          JSON.stringify(part)
        )
      })
    } else {
      db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id,
        sessionId,
        'assistant',
        sequence,
        JSON.stringify({ content: parts }),
        sequence,
        sequence
      )
    }
  }
  const prefix = version === 'v1' ? '' : 'opencode:'
  return { db, path, root, insert, prefix }
}

const mixed = (answer = 'ANSWER_SENTINEL') => [
  { type: 'reasoning', text: 'REASONING_SENTINEL' },
  { type: 'text', text: answer }
]

it('keeps reasoning apart from prose, image refs, tools, and applied patch records', () => {
  // Contracts captured through isolated 2.0.16 and official 1.18.30 CLI ingestion.
  const parts = [
    ...mixed(),
    { type: 'text', text: 'injected context', synthetic: true },
    { type: 'step-finish' },
    { type: 'file', mime: 'image/png', url: 'data:image/png;base64,YQ==' },
    { type: 'patch', hash: 'snapshot-before-edit', files: ['sentinel.txt', 3] }
  ].map((part) => ({ message_id: 'row', time_updated: 1, data: JSON.stringify(part) }))
  const messages = opencodeMessages({ id: 'row', role: 'assistant', timestamp: 1 }, parts)
  expect(messages).toEqual([
    {
      id: 'row:reasoning',
      role: 'reasoning',
      timestamp: 1,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'REASONING_SENTINEL' }]
    },
    {
      id: 'row',
      role: 'assistant',
      timestamp: 1,
      source: 'transcript',
      blocks: [
        { type: 'text', text: 'ANSWER_SENTINEL' },
        { type: 'image-ref', url: 'data:image/png;base64,YQ==' },
        {
          type: 'tool-call',
          name: 'patch',
          state: 'completed',
          input: { hash: 'snapshot-before-edit', files: ['sentinel.txt'] }
        }
      ]
    }
  ])
  expect(
    opencodeMessages({ id: 'thinking', role: 'assistant', timestamp: null }, parts.slice(0, 1))
  ).toEqual([
    {
      id: 'thinking',
      role: 'reasoning',
      timestamp: null,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'REASONING_SENTINEL' }]
    }
  ])
})

describe.each(['v1', 'v2'] as const)('%s semantic pagination', (version) => {
  it.each([1, 2, 3])('reconstructs sparse mixed history once with a page limit of %i', (limit) => {
    const { path, insert, prefix } = fixture(version)
    const expected: string[] = []
    for (let index = 0; index < 12; index++) {
      const id = String(index)
      if (index % 3 === 1) {
        insert(id, [{ type: 'step-start' }])
      } else if (index % 3 === 2) {
        insert(id, mixed())
        expected.push(`${prefix}${id}:reasoning`, `${prefix}${id}`)
      } else {
        insert(id, [{ type: 'text', text: id }])
        expected.push(`${prefix}${id}`)
      }
    }
    const pages: NativeChatMessage[][] = []
    let cursor: number | undefined
    for (let pageIndex = 0; pageIndex < 30; pageIndex++) {
      const page = readOpenCodeTranscriptPage({
        dbPath: path,
        sessionId: 'session',
        limit,
        beforeMessageRowId: cursor
      })!
      expect(page.items.length).toBeLessThanOrEqual(limit + 1)
      for (const item of page.items.filter((item) => item.message.role === 'reasoning')) {
        expect(
          page.items.some(
            (other) => other.rowid === item.rowid && other.message.role === 'assistant'
          )
        ).toBe(true)
      }
      pages.push(page.items.map((item) => item.message))
      if (!page.hasMore) {
        break
      }
      expect(page.beforeMessageRowId).toBeLessThan(cursor ?? Number.MAX_SAFE_INTEGER)
      cursor = page.beforeMessageRowId ?? undefined
    }
    expect(
      pages
        .toReversed()
        .flat()
        .map((message) => message.id)
    ).toEqual(expected)
  })

  it('exports exact complete history beyond the reader window into a persistent reusable file', async () => {
    const { db, path, root, insert, prefix } = fixture(version)
    const expected: string[] = []
    db.exec('BEGIN')
    for (let index = 0; index < 260; index++) {
      insert(String(index), mixed(`session message ${index}`))
      expected.push(`${prefix}${index}:reasoning`, `${prefix}${index}`)
    }
    db.exec('COMMIT')
    insert('other', mixed('OTHER_SENTINEL'), 'other')
    insert('tool', [
      {
        type: 'tool',
        tool: 'bash',
        name: 'bash',
        state: {
          status: 'completed',
          output: 'TOOL_SENTINEL',
          content: [{ type: 'text', text: 'TOOL_SENTINEL' }]
        }
      },
      {
        type: 'file',
        mime: 'text/plain',
        filename: 'attachment.txt',
        url: 'file:///work/attachment.txt'
      }
    ])
    expected.push(`${prefix}tool`)
    const result = await readOpenCodeNativeChatTranscriptFull('session', {
      resolveDbPath: async () => path,
      readPage: async (args) => readOpenCodeTranscriptPage(args)
    })
    expect('messages' in result && result.messages.map((message) => message.id)).toEqual(expected)
    const record = agentSessionRecordFixture()
    const source = {
      provider: 'opencode',
      handle: record.providerHandleChain[0],
      accountHome: record.accountHome,
      store: path,
      transcriptPath: path,
      workspaceCwd: '/work',
      providerSessionId: 'session'
    }
    const output = join(root, 'scratch', 'context.json')
    expect(await prepareOpenCodeReadableContext(source, output)).toBe(output)
    // Preparation has no process-memory requirement and never creates one file per click.
    expect(await prepareOpenCodeReadableContext(source, output)).toBe(output)
    expect(await readdir(join(root, 'scratch'))).toEqual(['context.json'])
    const text = await readFile(output, 'utf8')
    for (const expected of [
      'session message 0',
      'session message 259',
      'TOOL_SENTINEL',
      'attachment.txt',
      'text/plain',
      'file:///work/attachment.txt'
    ]) {
      expect(text.includes(expected)).toBe(true)
    }
    expect(text.includes('OTHER_SENTINEL')).toBe(false)
    expect(
      await prepareOpenCodeReadableContext({ ...source, providerSessionId: 'missing' }, output)
    ).toBeNull()
    await expect(
      prepareOpenCodeReadableContext({ ...source, workspaceCwd: '/elsewhere' }, output)
    ).rejects.toThrow('another directory')
    insert('oversized', [{ type: 'text', text: 'x'.repeat(3 * 1024 * 1024) }])
    expect(await prepareOpenCodeReadableContext(source, output)).toBeNull()
  })

  it('keeps both presentations on streaming mutation and new rows', async () => {
    const { db, path, insert, prefix } = fixture(version)
    insert('reply', mixed())
    const snapshots: NativeChatMessage[][] = []
    const replacements: NativeChatMessage[][] = []
    const appends: NativeChatMessage[][] = []
    let visible: NativeChatMessage[] = []
    const subscription = subscribeOpenCodeNativeChatTranscript(
      {
        agent: 'opencode',
        sessionId: 'session',
        initialLimit: 1,
        resolvePollIntervalMs: 5,
        onAppend: (messages) => {
          appends.push(messages)
          visible.push(...messages)
        },
        onInitialSnapshot: (messages) => {
          snapshots.push(messages)
          visible = [...messages]
        },
        onReplace: (messages) => {
          replacements.push(messages)
          visible = [...messages]
        }
      },
      undefined,
      {
        resolveDbPath: async () => path,
        readSignal: async (dbPath, sessionId) => readOpenCodeTranscriptSignal(dbPath, sessionId),
        readPage: async (args) => readOpenCodeTranscriptPage(args)
      }
    )
    try {
      await expect.poll(() => snapshots.length).toBe(1)
      expect(snapshots[0].map((message) => message.role)).toEqual(['reasoning', 'assistant'])
      if (version === 'v1') {
        db.prepare("UPDATE part SET data = ?, time_updated = 100 WHERE id = 'reply:1'").run(
          JSON.stringify({ type: 'text', text: 'complete' })
        )
      } else {
        db.prepare('UPDATE session_message SET data = ?, time_updated = 100').run(
          JSON.stringify({ content: mixed('complete') })
        )
      }
      await expect.poll(() => replacements.length).toBe(1)
      expect(replacements[0].map((message) => message.role)).toEqual(['reasoning', 'assistant'])
      expect(replacements[0][1].blocks).toEqual([{ type: 'text', text: 'complete' }])
      insert('next', mixed('next answer'))
      await expect.poll(() => appends.length + replacements.length).toBe(2)
      expect(visible.map((message) => message.id)).toEqual(
        ['reply:reasoning', 'reply', 'next:reasoning', 'next'].map((id) => `${prefix}${id}`)
      )
      expect(visible.map((message) => message.role)).toEqual([
        'reasoning',
        'assistant',
        'reasoning',
        'assistant'
      ])
      expect(visible[1].blocks).toEqual([{ type: 'text', text: 'complete' }])
      expect(visible[3].blocks).toEqual([{ type: 'text', text: 'next answer' }])
    } finally {
      subscription.unsubscribe()
    }
  })

  it('keeps complete pairs around an omitted oversized history row', () => {
    const { path, insert, prefix } = fixture(version)
    insert('before', mixed('BEFORE'))
    insert('large', [
      ...mixed('MIDDLE'),
      { type: 'file', mime: 'image/png', url: '😀'.repeat(2 * 1024 * 1024) }
    ])
    insert('after', mixed('AFTER'))
    const messages: NativeChatMessage[] = []
    const cursors = new Set<number>()
    let beforeMessageRowId: number | undefined
    while (true) {
      const page = readOpenCodeTranscriptPage({
        dbPath: path,
        sessionId: 'session',
        limit: 1,
        beforeMessageRowId
      })
      expect(page).not.toBeNull()
      if (!page) {
        throw new Error('History page unavailable')
      }
      messages.unshift(...page.items.map((item) => item.message))
      if (!page.hasMore) {
        break
      }
      expect(page.beforeMessageRowId).not.toBeNull()
      if (page.beforeMessageRowId === null) {
        throw new Error('History cursor unavailable')
      }
      expect(cursors.has(page.beforeMessageRowId)).toBe(false)
      cursors.add(page.beforeMessageRowId)
      beforeMessageRowId = page.beforeMessageRowId
    }
    const middleIds = version === 'v1' ? ['large:reasoning', 'large', 'large:omission'] : ['large']
    expect(messages.map((message) => message.id)).toEqual(
      ['before:reasoning', 'before', ...middleIds, 'after:reasoning', 'after'].map(
        (id) => `${prefix}${id}`
      )
    )
    const notices = messages.flatMap((message) =>
      message.blocks.filter(
        (block) =>
          block.type === 'text' &&
          block.text === AGENT_SESSION_HOST_STATUS_COPY['history-item-too-large']
      )
    )
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ presentation: 'history-item-too-large' })
    const noticeRow = messages.find((message) =>
      message.blocks.some(
        (block) => block.type === 'text' && block.presentation === 'history-item-too-large'
      )
    )
    expect(noticeRow?.role).toBe('system')
    expect(noticeRow?.transcriptOffset).toBeTypeOf('number')
    expect(Buffer.byteLength(JSON.stringify(messages))).toBeLessThan(4096)
  })

  it('enforces one page byte budget across multiple mixed rows', () => {
    const { path, insert } = fixture(version)
    const large = 'x'.repeat(1_000_000)
    for (let index = 0; index < 20; index++) {
      insert(String(index), [
        { type: 'reasoning', text: large },
        { type: 'text', text: large }
      ])
    }
    expect(() =>
      readOpenCodeTranscriptPage({ dbPath: path, sessionId: 'session', limit: 40 })
    ).toThrow('read limit')
  })
})
