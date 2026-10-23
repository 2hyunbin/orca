import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { parseMuseSessionContent, parseMuseSessionFile } from './session-scanner-muse-parser'
import {
  isolatedScanRoots,
  jsonLines,
  writeMuseScannerFixture
} from './session-scanner-test-fixtures'
import type { TranscriptMessage } from './session-transcript-consumers'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

describe('scanAiVaultSessions muse', () => {
  it('indexes Muse envelopes with title, model, tokens, and resume command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-muse-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const sessionFile = await writeMuseScannerFixture(roots.museSessionsDir)

    const result = await scanAiVaultSessions({ ...roots, platform: 'darwin', limit: 20 })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    const session = result.sessions[0]
    expect(session.agent).toBe('muse')
    expect(session.sessionId).toBe('muse-session')
    expect(session.title).toBe('Muse vault title')
    expect(session.cwd).toBe('/tmp/muse')
    expect(session.model).toBe('muse-spark-test')
    expect(session.totalTokens).toBe(15)
    expect(session.messageCount).toBe(2)
    expect(session.filePath).toBe(sessionFile)
    expect(session.resumeCommand).toBe("cd '/tmp/muse' && muse resume 'muse-session'")
  })

  it('publishes user and assistant turns to transcript consumers', () => {
    const messages: TranscriptMessage[] = []
    const session = parseMuseSessionContent(
      {
        path: '/tmp/muse-sessions/2026/05/01/muse-capture/session.jsonl',
        mtimeMs: 1780000003000,
        modifiedAt: '2026-05-01T10:00:03.000Z'
      },
      jsonLines([
        {
          record_type: 'event',
          payload_type: 'runtime.user_intent.accepted',
          recorded_at: 1780000000000000,
          payload: { refill_blocks: [{ kind: 'text', text: 'Capture this prompt' }] }
        },
        {
          record_type: 'event',
          payload_type: 'runtime.session',
          recorded_at: 1780000001000000,
          payload: {
            kind: 'run',
            event: { kind: 'assistant_message_committed', text: 'Captured reply' }
          }
        }
      ]),
      'darwin',
      {},
      { active: true, push: (message) => messages.push(message) }
    )

    expect(session?.messageCount).toBe(2)
    expect(messages).toEqual([
      { role: 'user', text: 'Capture this prompt', timestamp: '2026-05-28T20:26:40.000Z' },
      { role: 'assistant', text: 'Captured reply', timestamp: '2026-05-28T20:26:41.000Z' }
    ])
  })

  it('streams the same records across byte boundaries, mixed endings, and an unterminated tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-muse-stream-'))
    tempRoots.push(root)
    const path = await writeMuseScannerFixture(root)
    let content = (await readFile(path, 'utf8')).replaceAll('\n', '\r\n')
    const tail = JSON.stringify({
      record_type: 'event',
      payload_type: 'runtime.session',
      recorded_at: 1780000004000000,
      payload: {
        kind: 'run',
        event: { kind: 'assistant_message_committed', text: 'Chunk edge 😊 tail' }
      }
    })
    const bareCrRecord = tail.replace('Chunk edge 😊 tail', 'bare CR record')
    content += `${bareCrRecord}\r${bareCrRecord}\n${tail}\r`
    const beforeEmoji = Buffer.byteLength(content.slice(0, content.indexOf('😊')))
    content = ' '.repeat(65_535 - beforeEmoji) + content
    await writeFile(path, content)
    const file = { path, mtimeMs: 1780000004000, modifiedAt: '2026-05-28T20:26:44.000Z' }
    const buffered: TranscriptMessage[] = []
    const streamed: TranscriptMessage[] = []
    const expected = parseMuseSessionContent(
      file,
      content,
      'linux',
      {},
      {
        active: true,
        push: (message) => buffered.push(message)
      }
    )
    const actual = await parseMuseSessionFile(file, 'linux', {
      active: true,
      push: (message) => streamed.push(message)
    })
    expect(actual).toEqual(expected)
    expect(streamed).toEqual(buffered)
    expect(actual?.messageCount).toBe(3)
    expect(streamed.at(-1)?.text).toBe('Chunk edge 😊 tail')
  })
})
