import { expect, it } from 'vitest'
import { createNativeChatMerger, replaceList } from '../../src/shared/native-chat-merge'
import type { NativeChatMessage } from '../../src/shared/native-chat-types'
import { applyMobileNativeChatStreamFrame } from '../../mobile/src/session/mobile-native-chat-stream-frame'

it('retains reader-produced tied image pages through prepend, append and reconnect into bubbles', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { readNativeChatTranscriptTail } =
    await import('../../src/main/native-chat/transcript-tail-reader')
  const { foldMobileNativeChatMessages } =
    await import('../../mobile/src/session/mobile-native-chat-render-data')
  const directory = await mkdtemp(join(tmpdir(), 'pr31794-mobile-'))
  const filePath = join(directory, 'session.jsonl')
  await writeFile(
    filePath,
    [
      ['z-source', '[Image: source: /tmp/first.png]'],
      ['z-prompt', 'first [Image #1]'],
      ['a-source', '[Image: source: /tmp/second.png]'],
      ['a-prompt', 'second [Image #1]']
    ]
      .map(
        ([id, text]) =>
          `${JSON.stringify({
            type: 'user',
            uuid: id,
            timestamp: '2026-06-01T10:00:00Z',
            message: { role: 'user', content: text }
          })}\n`
      )
      .join('')
  )
  try {
    const tail = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 's',
      filePath,
      limit: 1,
      sourceOrder: true
    })
    if (!('messages' in tail)) {
      throw new Error(tail.error)
    }
    const older = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 's',
      filePath,
      limit: 3,
      beforeOffset: tail.beforeOffset,
      sourceOrder: true
    })
    if (!('messages' in older)) {
      throw new Error(older.error)
    }
    const merger = createNativeChatMerger()
    const frame = (
      type: 'snapshot' | 'appended',
      messages: NativeChatMessage[],
      replaceSnapshot = false
    ) =>
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type, messages, hasMore: true },
        limit: 100,
        replaceSnapshot
      })
    frame('snapshot', tail.messages, true)
    replaceList(merger, [...older.messages, ...merger.list])
    frame('appended', tail.messages)
    frame('snapshot', tail.messages)
    const bubbles = foldMobileNativeChatMessages(merger.list, 'claude')
    expect(bubbles.map((row) => row.id)).toEqual(['z-prompt', 'a-prompt'])
    expect(
      bubbles.map((row) =>
        row.blocks.filter((block) => block.type === 'image-ref').map((block) => block.path)
      )
    ).toEqual([['/tmp/first.png'], ['/tmp/second.png']])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
