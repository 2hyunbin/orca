import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { deriveNativeChatContextUsage } from '../../shared/native-chat-context-usage'
import { nativeChatTurnFoldRow } from '../../shared/native-chat-turn-fold'
import { mergeNativeChatMessages } from '../../shared/native-chat-merge'
import { nativeChatNoticeBlock, nativeChatNoticeLook } from '../../shared/native-chat-notice'
import { projectStructuredItemToNativeChat } from '../../shared/structured-agent-session-projection'
import {
  legacyItemBody,
  LEGACY_IMPORT_BLOCK_LIMITS
} from './agent-session-journal/journal-legacy-import'
import { transcriptFallbackId } from './transcript-fallback-id'
import { readNativeChatTranscript } from './transcript-reader'
import { readNativeChatTranscriptTail } from './transcript-tail-reader'

const roots: string[] = []
const timestamp = '2026-08-13T10:00:01.000Z'
// STA-4099's reporter-observed payload, with its original redacted ID.
const observed = {
  type: 'event_msg',
  payload: { type: 'item_completed', item: { type: 'ContextCompaction', id: '...' } }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each(['paginated', 'legacy'])(
  'retains %s compaction through history consumers',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-compaction-'))
    roots.push(root)
    const filePath = join(root, 'rollout.jsonl')
    const event = (payload: unknown, time = timestamp) => ({
      type: 'event_msg',
      timestamp: time,
      payload
    })
    const completed = (item: unknown, time = timestamp) =>
      event({ type: 'item_completed', item }, time)
    // ID, timestamp, thread/turn IDs and completion timing are test-supplied, not a captured wrapper.
    const compaction =
      mode === 'paginated'
        ? {
            ...observed,
            timestamp,
            payload: {
              ...observed.payload,
              item: { ...observed.payload.item, id: 'compaction-1' },
              thread_id: 'thread-1',
              turn_id: 'turn-1',
              completed_at_ms: 7
            }
          }
        : // Source-serialization coverage: the legacy provider event is an empty tagged payload.
          event({ type: 'context_compacted' })
    const records = [
      mode === 'paginated'
        ? completed(
            {
              type: 'UserMessage',
              id: 'user-1',
              content: [
                { type: 'text', text: 'Prompt' },
                { type: 'image', image_url: 'data:image/png;base64,abc' }
              ]
            },
            '2026-08-13T10:00:00.000Z'
          )
        : event({ type: 'user_message', message: 'Prompt' }, '2026-08-13T10:00:00.000Z'),
      { type: 'response_item', payload: { type: 'compaction', encrypted_content: 'opaque' } },
      {
        type: 'response_item',
        payload: { type: 'context_compaction', encrypted_content: 'opaque' }
      },
      { type: 'compacted', payload: { message: 'model context', replacement_history: [] } },
      completed({ type: 'UserMessage', id: 'empty-user', content: [] }),
      completed({ type: 'AgentMessage', id: 'empty-agent' }),
      compaction,
      mode === 'paginated'
        ? completed(
            {
              type: 'AgentMessage',
              id: 'assistant-1',
              content: [{ type: 'Text', text: 'Response' }]
            },
            '2026-08-13T10:00:02.000Z'
          )
        : event({ type: 'agent_message', message: 'Response' }, '2026-08-13T10:00:02.000Z')
    ]
    await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
    const full = await readNativeChatTranscript('codex', 'session-1', { filePath })
    const tail = await readNativeChatTranscriptTail({
      agent: 'codex',
      sessionId: 'session-1',
      filePath,
      limit: 10
    })
    if (!('messages' in full) || !('messages' in tail)) {
      throw new Error('Expected transcript messages')
    }
    expect(full.messages.map((message) => message.role)).toEqual(['user', 'system', 'assistant'])
    expect(full.messages[0]?.blocks).toEqual([
      { type: 'text', text: 'Prompt' },
      ...(mode === 'paginated' ? [{ type: 'image-ref', url: 'data:image/png;base64,abc' }] : [])
    ])
    const response = full.messages[2]
    const marker = full.messages[1]
    if (!marker || !response) {
      throw new Error('Expected compaction and response')
    }
    expect(response.blocks).toEqual([{ type: 'text', text: 'Response' }])
    const markerOffset = Buffer.byteLength(
      `${records
        .slice(0, records.indexOf(compaction))
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`
    )
    expect(marker).toEqual({
      id: mode === 'paginated' ? 'compaction-1' : transcriptFallbackId(filePath, markerOffset),
      role: 'system',
      timestamp: Date.parse(timestamp),
      source: 'transcript',
      blocks: [{ type: 'text', text: 'Context compacted', presentation: 'compaction' }]
    })
    expect(tail.messages).toEqual(full.messages)
    expect(mergeNativeChatMessages(full.messages, tail.messages)).toEqual(full.messages)

    const projected = projectStructuredItemToNativeChat({
      itemId: marker.id,
      revision: 1,
      sequence: 2,
      observedAt: marker.timestamp ?? 0,
      body: legacyItemBody(marker, LEGACY_IMPORT_BLOCK_LIMITS)
    })
    expect(projected).toMatchObject(marker)
    const notice = nativeChatNoticeBlock(projected?.blocks ?? [])
    expect(notice && nativeChatNoticeLook(notice)).toEqual({ kind: 'divider', label: 'compaction' })
    expect(projected && nativeChatTurnFoldRow(projected, 'turn-1', false).explainsTurn).toBe(true)
    const measured = {
      ...response,
      usage: {
        inputTokens: 100,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0
      }
    }
    expect(deriveNativeChatContextUsage([measured], () => 1000)?.usedTokens).toBe(100)
    expect(deriveNativeChatContextUsage([measured, marker], () => 1000)).toBeNull()
  }
)
