import { afterEach, expect, it, vi } from 'vitest'
import type { ResumableSessionParseState, SessionFileCandidate } from './session-scanner-types'
import {
  registerTranscriptConsumer,
  resetTranscriptConsumersForTests,
  type TranscriptReadOutcome
} from './session-transcript-consumers'

const readers = vi.hoisted(() => ({ parse: vi.fn(), lines: vi.fn() }))
vi.mock('./session-scanner-agent-parser', () => ({ parseAgentSessionFile: readers.parse }))
vi.mock('./session-scanner-jsonl-reader', () => ({ consumeCompleteJsonlLines: readers.lines }))

import { readResumableTranscript, readWholeTranscript } from './session-transcript-reader'

afterEach(() => resetTranscriptConsumersForTests())

it.each(['parser', 'finalizer'] as const)(
  'keeps a cancellation swallowed by the %s out of the completed outcome',
  async (boundary) => {
    const controller = new AbortController()
    const outcomes: TranscriptReadOutcome[] = []
    registerTranscriptConsumer({
      beginRead: () => ({ message: () => {}, finish: (outcome) => outcomes.push(outcome) })
    })
    const candidate: SessionFileCandidate = {
      agent: 'grok',
      codexHome: null,
      file: {
        path: '/synthetic.json',
        mtimeMs: 1,
        sizeBytes: 0,
        modifiedAt: new Date(1).toISOString()
      }
    }
    readers.parse.mockImplementation(async () => {
      controller.abort()
      return null
    })
    readers.lines.mockResolvedValue({
      consumedThrough: 0,
      trailingPartialLine: null,
      bytesRead: 0,
      skippedRecords: []
    })
    const state: ResumableSessionParseState = {
      clone: () => state,
      consumeLine: () => {},
      touchFile: () => {},
      finalize: async () => {
        controller.abort()
        return null
      }
    }
    const args = { candidate, platform: process.platform, signal: controller.signal }
    const read =
      boundary === 'parser'
        ? readWholeTranscript(args)
        : readResumableTranscript({ ...args, resume: null, stateFactory: () => state })
    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    expect(outcomes).toEqual([
      expect.objectContaining({ incomplete: true, cancelled: true, session: null })
    ])
  }
)
