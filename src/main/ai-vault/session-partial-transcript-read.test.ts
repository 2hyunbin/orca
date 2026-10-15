import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'
import { parseAgentSessionFile } from './session-scanner-agent-parser'
import { codexFixture } from './session-scanner-codex-fixtures'
import type { IncrementalAgentFixture } from './session-scanner-incremental-fixtures'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import type { SessionFileCandidate } from './session-scanner-types'
import {
  registerTranscriptConsumer,
  resetTranscriptConsumersForTests,
  type TranscriptReadStart
} from './session-transcript-consumers'
import { PARTIAL_READ_MIN_BYTES, PARTIAL_READ_TAIL_BYTES } from './session-transcript-reader'

const CLAUDE_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function claudeFixture(): IncrementalAgentFixture {
  const line = (type: 'user' | 'assistant', text: string, at: string) =>
    JSON.stringify({
      type,
      sessionId: CLAUDE_SESSION_ID,
      timestamp: at,
      cwd: '/repo/app',
      gitBranch: 'main',
      message: { role: type, model: 'claude-opus-5-5', content: text }
    })
  return {
    agent: 'claude',
    fileName: `${CLAUDE_SESSION_ID}.jsonl`,
    seedLines: [
      line('user', 'claude seed question'.repeat(20), '2026-05-01T10:00:00.000Z'),
      line('assistant', 'claude seed answer', '2026-05-01T10:00:10.000Z')
    ],
    appendLines: [
      line('user', 'claude follow-up', '2026-05-01T10:05:00.000Z'),
      line('assistant', 'claude incremental answer', '2026-05-01T10:05:10.000Z')
    ],
    truncatedLines: []
  }
}

// Unknown records keep the fixture large without adding preview turns.
const FILLER_LINE = JSON.stringify({ type: 'filler', pad: 'x'.repeat(4000) })
const FILLER_LINES = Math.ceil(PARTIAL_READ_MIN_BYTES / 4000) + 4

let root: string
let begins: TranscriptReadStart[]
let messages: string[]
let finishes: number

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  root = await mkdtemp(join(tmpdir(), 'orca-partial-read-'))
  begins = []
  messages = []
  finishes = 0
  registerTranscriptConsumer({
    beginRead: (start) => {
      begins.push(start)
      return { message: (message) => messages.push(message.text), finish: () => finishes++ }
    }
  })
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  await rm(root, { recursive: true, force: true })
})

async function candidateFor(fixture: IncrementalAgentFixture): Promise<SessionFileCandidate> {
  const path = join(root, fixture.fileName)
  const fileStat = await stat(path)
  return {
    agent: fixture.agent,
    file: {
      path,
      mtimeMs: fileStat.mtimeMs,
      modifiedAt: fileStat.mtime.toISOString(),
      sizeBytes: fileStat.size
    },
    codexHome: null
  }
}

describe.each([claudeFixture(), codexFixture()])('partial list read: $agent', (fixture) => {
  it('preserves every metadata field with suffix previews, silent append and exact upgrade', async () => {
    const path = join(root, fixture.fileName)
    const lastAppend = fixture.appendLines[1]
    const filler = Array<string>(FILLER_LINES).fill(FILLER_LINE)
    const middle =
      fixture.agent === 'claude'
        ? [
            { type: 'ai-title', aiTitle: 'middle generated title' },
            { type: 'custom-title', customTitle: 'middle custom title' },
            { type: 'last-prompt', lastPrompt: 'middle latest ask' },
            { type: 'queue-operation', operation: 'enqueue', content: 'pending' },
            { type: 'queue-operation', operation: 'dequeue' },
            { type: 'queue-operation', operation: 'enqueue', content: 'still pending' },
            { type: 'filler', timestamp: '2026-04-01T00:00:00Z', gitBranch: 'middle' }
          ]
        : [
            { type: 'turn_context', payload: { cwd: '/repo/middle', model: 'gpt-middle' } },
            { type: 'event_msg', payload: { type: 'user_message', message: 'middle latest ask' } },
            {
              type: 'event_msg',
              payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 25 } } }
            },
            { type: 'filler', timestamp: '2026-04-01T00:00:00Z' }
          ]
    await writeFile(
      path,
      `${[...fixture.seedLines, ...filler, ...middle.map((record) => JSON.stringify(record)), ...filler, lastAppend].join('\n')}\n`
    )

    const stats = createSessionParseStats()
    const candidate = await candidateFor(fixture)
    const whole = await withFullFirstUserPromptCapture(() =>
      parseAgentSessionFile(candidate, process.platform)
    )
    const partial = await withFullFirstUserPromptCapture(() =>
      parseAgentSessionFileCached(candidate, process.platform, stats, 'partial-ok')
    )
    expect(stats.bytesRead).toBe(candidate.file.sizeBytes)
    expect(stats.partialReads).toBe(1)
    expect(partial).toEqual({
      ...whole,
      contentCoverage: 'partial',
      previewMessages: partial?.previewMessages,
      previewMessagesTruncated: true
    })
    // The preview comes from the tail alone, never spliced onto the opening turns.
    expect(partial?.previewMessages.length).toBeGreaterThan(0)
    expect(partial?.previewMessages).toEqual(
      whole?.previewMessages.slice(-(partial?.previewMessages.length ?? 0))
    )

    // An append resumes the partial fold, still unpublished.
    await appendFile(path, `${lastAppend}\n`)
    const grown = await parseAgentSessionFileCached(
      await candidateFor(fixture),
      process.platform,
      stats,
      'partial-ok'
    )
    expect(stats.incremental).toBe(1)
    expect(grown?.contentCoverage).toBe('partial')
    expect(begins).toEqual([])
    expect(messages).toEqual([])
    expect(finishes).toBe(0)

    // A caller that needs the whole file never gets the partial row.
    const grownCandidate = await candidateFor(fixture)
    const exact = await withFullFirstUserPromptCapture(() =>
      parseAgentSessionFileCached(grownCandidate, process.platform)
    )
    expect(exact).toEqual(
      await withFullFirstUserPromptCapture(() =>
        parseAgentSessionFile(grownCandidate, process.platform)
      )
    )
    expect(grown).toEqual({
      ...exact,
      contentCoverage: 'partial',
      previewMessages: grown?.previewMessages,
      previewMessagesTruncated: true
    })
    expect(exact?.contentCoverage).toBeUndefined()
    expect(begins.map((start) => start.mode)).toEqual(['replace'])
    expect(messages).toHaveLength(exact?.messageCount ?? 0)
    expect(finishes).toBe(1)
  })
})

// The cutoff belongs to record starts, including exact alignment and unfinished records.
it.each([0, 1])('projects only records starting in the suffix (crossing=%s)', async (crossing) => {
  const fixture = claudeFixture()
  const path = join(root, fixture.fileName)
  const turn = fixture.appendLines[1]
  const emptyPad = JSON.stringify({ type: 'filler', pad: '' })
  const pad = JSON.stringify({
    type: 'filler',
    pad: 'x'.repeat(
      PARTIAL_READ_TAIL_BYTES + crossing - Buffer.byteLength(`${turn}\n${emptyPad}\n`)
    )
  })
  await writeFile(
    path,
    [...fixture.seedLines, ...Array<string>(FILLER_LINES).fill(FILLER_LINE), turn, pad, ''].join(
      '\n'
    )
  )
  const partial = await parseAgentSessionFileCached(
    await candidateFor(fixture),
    process.platform,
    undefined,
    'partial-ok'
  )
  expect(partial?.messageCount).toBe(3)
  expect(partial?.previewMessages.map((message) => message.text)).toEqual(
    crossing ? [] : ['claude incremental answer']
  )
  expect(begins).toEqual([])
})

it('enables append previews when an unfinished record started before the suffix', async () => {
  const fixture = claudeFixture()
  const path = join(root, fixture.fileName)
  const unfinished = JSON.stringify({
    type: 'assistant',
    message: { content: 'z'.repeat(PARTIAL_READ_TAIL_BYTES + 1) }
  })
  await writeFile(
    path,
    [...fixture.seedLines, ...Array<string>(FILLER_LINES).fill(FILLER_LINE), unfinished].join('\n')
  )
  const partial = await parseAgentSessionFileCached(
    await candidateFor(fixture),
    process.platform,
    undefined,
    'partial-ok'
  )
  expect(partial?.previewMessages).toEqual([])
  expect(partial?.messageCount).toBe(3)
  await appendFile(path, `\n${fixture.appendLines[1]}\n`)
  const grown = await parseAgentSessionFileCached(
    await candidateFor(fixture),
    process.platform,
    undefined,
    'partial-ok'
  )
  expect(grown?.messageCount).toBe(4)
  expect(grown?.previewMessages).toHaveLength(2)
  expect(grown?.previewMessages.at(-1)?.text).toBe('claude incremental answer')
  expect(begins).toEqual([])
})
