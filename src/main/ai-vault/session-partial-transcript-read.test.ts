import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as listDecoder from './session-list-record-decoder'
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
import { LIST_ONLY_MIN_BYTES } from './session-transcript-reader'
import { readAiVaultSessionTitlesFromFiles } from './session-title-file-reader'
import { getSessionParseCacheEntry } from './session-parse-cache-store'

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
      line('user', 'claude seed question', '2026-05-01T10:00:00.000Z'),
      line('assistant', 'claude seed answer', '2026-05-01T10:00:10.000Z')
    ],
    appendLines: [
      line('user', 'claude follow-up', '2026-05-01T10:05:00.000Z'),
      line('assistant', 'claude incremental answer', '2026-05-01T10:05:10.000Z')
    ],
    truncatedLines: []
  }
}

// Untimestamped records no parser reads, so the gap is pure size.
const FILLER_LINE = JSON.stringify({ type: 'filler', pad: 'x'.repeat(4000) })
const FILLER_LINES = Math.ceil(LIST_ONLY_MIN_BYTES / 4000) + 4

let root: string
let begins: TranscriptReadStart[]

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  root = await mkdtemp(join(tmpdir(), 'orca-partial-read-'))
  begins = []
  registerTranscriptConsumer({
    beginRead: (start) => {
      begins.push(start)
      return { message: () => undefined, finish: () => undefined }
    }
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  resetTranscriptConsumersForTests()
  await rm(root, { recursive: true, force: true })
})

it('keeps the complete-line cursor and cached fold across display tails and cancelled appends', async () => {
  const fixture = claudeFixture()
  const path = join(root, fixture.fileName)
  const prefix = `${[...fixture.seedLines, ...Array<string>(FILLER_LINES).fill(FILLER_LINE)].join('\r\n')}\r\n`
  const tail = JSON.stringify({ type: 'user', message: { content: '日本語😀 tail' } })
  await writeFile(path, prefix + tail)
  const first = await parseAgentSessionFileCached(await candidateFor(fixture), process.platform,
    undefined, 'partial-ok')
  expect(getSessionParseCacheEntry(path)?.resume?.byteOffset).toBe(Buffer.byteLength(prefix))
  await appendFile(path, '\r\n')
  expect(await parseAgentSessionFileCached(await candidateFor(fixture), process.platform,
    undefined, 'partial-ok')).toMatchObject({ messageCount: first?.messageCount,
    previewMessages: first?.previewMessages })
  const before = getSessionParseCacheEntry(path)
  await appendFile(path, `${fixture.appendLines.join('\n')}\n`)
  const controller = new AbortController()
  const decode = listDecoder.decodeSessionListRecord
  let consumed = 0
  vi.spyOn(listDecoder, 'decodeSessionListRecord').mockImplementation(async (...args) => {
    if (++consumed === 2) {
      controller.abort()
    }
    return decode(...args)
  })
  await expect(parseAgentSessionFileCached(await candidateFor(fixture), process.platform,
    undefined, 'partial-ok', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(getSessionParseCacheEntry(path)).toBe(before)
  vi.restoreAllMocks()
  const recovered = await parseAgentSessionFileCached(await candidateFor(fixture), process.platform,
    undefined, 'partial-ok')
  expect(recovered).toEqual({ ...await parseAgentSessionFile(await candidateFor(fixture),
    process.platform), contentCoverage: 'partial' })
  expect(begins).toEqual([])
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
  it('preserves middle-only list and action inputs without publishing, then replaces whole', async () => {
    const path = join(root, fixture.fileName)
    const firstAppends = fixture.appendLines.slice(0, -1)
    const lastAppend = fixture.appendLines.at(-1)
    const filler = Array<string>(FILLER_LINES).fill(FILLER_LINE)
    const middle: Record<string, unknown>[] = fixture.agent === 'claude' ? [
      { type: 'custom-title', customTitle: 'discarded name' },
      { type: 'ai-title', aiTitle: 'generated name' },
      { type: 'custom-title', customTitle: null },
      { type: 'ai-title', aiTitle: '' },
      { type: 'custom-title', customTitle: 'saved middle name' },
      { type: 'last-prompt', lastPrompt: 'authenticated middle prompt' },
      { type: 'assistant', timestamp: '2026-05-04T00:00:00Z', gitBranch: 'middle-branch',
        message: { model: 'middle-model', content: ['middle reply', { content: 'direct part' }] } }
    ] : [
      { type: 'turn_context', timestamp: '2026-05-04T00:00:00Z',
        payload: { cwd: '/repo/moved', metadata: { model: 'middle-model' } } }
    ]
    middle.push({ type: 'progress', timestamp: '2026-04-01T00:00:00Z' })
    const suffix = JSON.stringify({ type: 'progress', timestamp: '2026-05-02T00:00:00Z',
      ignored: 'x'.repeat(20000) })
    const conversation = Array.from({ length: 6 }, (_, index) => JSON.stringify(
      fixture.agent === 'claude' ? { type: index % 2 ? 'assistant' : 'user',
        message: { content: `middle turn ${index}` } } : { type: 'event_msg',
        payload: { type: index % 2 ? 'agent_message' : 'user_message', message: `middle turn ${index}` } }
    ))
    await writeFile(path, `${[...fixture.seedLines, ...filler, ...firstAppends,
      ...conversation, ...middle.map((record) => JSON.stringify(record)),
      ...Array<string>(20).fill(suffix)].join('\n')}\n`)
    const stats = createSessionParseStats()
    const whole = await parseAgentSessionFile(await candidateFor(fixture), process.platform)
    const partial = await parseAgentSessionFileCached(
      await candidateFor(fixture),
      process.platform,
      stats,
      'partial-ok'
    )
    expect(stats.partialReads).toBe(1)
    expect(whole).not.toBeNull()
    expect(partial).toEqual({ ...whole, contentCoverage: 'partial' })
    expect(partial?.previewMessages).toHaveLength(5)
    expect(stats.bytesRead).toBe((await stat(path)).size)
    expect(await parseAgentSessionFileCached(await candidateFor(fixture), process.platform, stats,
      'partial-ok')).toBe(partial)
    expect(stats.reused).toBe(1)
    if (fixture.agent === 'claude') {
      resetSessionParseCacheForTests()
      const titles = await readAiVaultSessionTitlesFromFiles([
        { agent: 'claude', sessionId: CLAUDE_SESSION_ID, transcriptPath: path }
      ])
      expect(titles.titles[0]?.title).toBe('saved middle name')
    }

    // An append resumes the partial fold, still unpublished.
    await appendFile(path, `${lastAppend}\n`)
    const grown = await parseAgentSessionFileCached(
      await candidateFor(fixture),
      process.platform,
      stats,
      'partial-ok'
    )
    expect(stats.incremental).toBe(1)
    expect(grown).toEqual({ ...await parseAgentSessionFile(await candidateFor(fixture),
      process.platform), contentCoverage: 'partial' })
    expect(begins).toEqual([])

    // A caller that needs the whole file never gets the partial row.
    const exact = await parseAgentSessionFileCached(await candidateFor(fixture), process.platform)
    expect(exact).toEqual(
      await parseAgentSessionFile(await candidateFor(fixture), process.platform)
    )
    expect(exact?.contentCoverage).toBeUndefined()
    expect(begins.map((start) => start.mode)).toEqual(['replace'])
  })
})
