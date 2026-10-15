import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import { PARTIAL_READ_HEAD_BYTES, PARTIAL_READ_TAIL_BYTES } from './session-transcript-reader'

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
const FILLER_LINES = Math.ceil((PARTIAL_READ_HEAD_BYTES + PARTIAL_READ_TAIL_BYTES) / 4000) + 4

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
  it('lists a large transcript from its ends without publishing, and re-reads whole on demand', async () => {
    const path = join(root, fixture.fileName)
    const firstAppends = fixture.appendLines.slice(0, -1)
    const lastAppend = fixture.appendLines.at(-1)
    const filler = Array<string>(FILLER_LINES).fill(FILLER_LINE)
    await writeFile(path, `${[...fixture.seedLines, ...filler, ...firstAppends].join('\n')}\n`)
    const stats = createSessionParseStats()
    const whole = await parseAgentSessionFile(await candidateFor(fixture), process.platform)
    const partial = await parseAgentSessionFileCached(
      await candidateFor(fixture),
      process.platform,
      stats,
      'partial-ok'
    )
    expect(stats.partialReads).toBe(1)
    expect(partial).toMatchObject({
      contentCoverage: 'partial',
      sessionId: whole?.sessionId,
      title: whole?.title,
      cwd: whole?.cwd,
      model: whole?.model,
      createdAt: whole?.createdAt,
      updatedAt: whole?.updatedAt
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

    // A caller that needs the whole file never gets the partial row.
    const exact = await parseAgentSessionFileCached(await candidateFor(fixture), process.platform)
    expect(exact).toEqual(
      await parseAgentSessionFile(await candidateFor(fixture), process.platform)
    )
    expect(exact?.contentCoverage).toBeUndefined()
    expect(begins.map((start) => start.mode)).toEqual(['replace'])
  })
})
