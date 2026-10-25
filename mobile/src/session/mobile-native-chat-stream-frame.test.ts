import { describe, expect, it } from 'vitest'
import { createNativeChatMerger, replaceList } from '../../../src/shared/native-chat-merge'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { applyMobileNativeChatStreamFrame } from './mobile-native-chat-stream-frame'

function message(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 0,
    source: 'transcript'
  }
}

describe('applyMobileNativeChatStreamFrame', () => {
  it('uses the first snapshot as the ordered base and carries pagination state', () => {
    const merger = createNativeChatMerger()
    const result = applyMobileNativeChatStreamFrame({
      merger,
      frame: {
        type: 'snapshot',
        messages: [message('a'), message('b')],
        hasMore: true,
        beforeOffset: 123
      },
      limit: 40,
      replaceSnapshot: true
    })

    expect(result).toEqual({
      kind: 'messages',
      messages: [message('a'), message('b')],
      hasMore: true,
      beforeOffset: 123,
      windowReplaced: true
    })
  })

  it('marks a pending snapshot so the caller can settle the view but not the read', () => {
    const merger = createNativeChatMerger()
    const result = applyMobileNativeChatStreamFrame({
      merger,
      frame: { type: 'snapshot', messages: [], hasMore: false, pending: true },
      limit: 40,
      replaceSnapshot: true
    })

    expect(result).toEqual({
      kind: 'messages',
      messages: [],
      hasMore: false,
      windowReplaced: true,
      pending: true
    })
  })

  it('merges reconnect snapshots and live appends into the bounded window', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, [message('a'), message('b')])

    const result = applyMobileNativeChatStreamFrame({
      merger,
      frame: {
        type: 'snapshot',
        messages: [message('b'), message('c'), message('d')],
        hasMore: true,
        beforeOffset: 20
      },
      limit: 3,
      replaceSnapshot: false
    })

    expect(result).toMatchObject({
      kind: 'messages',
      messages: [message('b'), message('c'), message('d')],
      cursorInvalidated: true,
      hasMore: true
    })
  })

  it('refreshes paging metadata when a replay still starts at the retained oldest row', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, [message('a'), message('b')])

    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: {
          type: 'snapshot',
          messages: [message('a'), message('b')],
          hasMore: false,
          beforeOffset: 0
        },
        limit: 40,
        replaceSnapshot: false
      })
    ).toEqual({
      kind: 'messages',
      messages: [message('a'), message('b')],
      hasMore: false,
      beforeOffset: 0
    })
  })

  it('keeps paged-in history when a reconnect replay overlaps it', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, ['p1', 'p2', 'a', 'b'].map(message))

    const result = applyMobileNativeChatStreamFrame({
      merger,
      frame: { type: 'snapshot', messages: [message('a'), message('b'), message('c')] },
      limit: 100,
      replaceSnapshot: false
    })

    expect(result).toEqual({
      kind: 'messages',
      messages: ['p1', 'p2', 'a', 'b', 'c'].map(message)
    })
  })

  it('ignores replay paging metadata that describes a row other than our oldest', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, ['p1', 'p2', 'a', 'b'].map(message))

    // A replay cursor before a would fetch p1/p2 twice after retaining them.
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: {
          type: 'snapshot',
          messages: [message('a'), message('b')],
          hasMore: true,
          beforeOffset: 500
        },
        limit: 100,
        replaceSnapshot: false
      })
    ).toEqual({ kind: 'messages', messages: ['p1', 'p2', 'a', 'b'].map(message) })
  })

  it('replaces the window when a reconnect replay is disjoint from history', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, [message('old-1'), message('old-2')])

    const result = applyMobileNativeChatStreamFrame({
      merger,
      frame: {
        type: 'snapshot',
        messages: [message('fresh-1'), message('fresh-2')],
        hasMore: true,
        beforeOffset: 900
      },
      limit: 100,
      replaceSnapshot: false
    })

    expect(result).toEqual({
      kind: 'messages',
      messages: [message('fresh-1'), message('fresh-2')],
      hasMore: true,
      beforeOffset: 900,
      windowReplaced: true
    })
  })

  it('replaces a partially overlapping replay that no longer extends the retained tail', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, ['old-1', 'shared', 'old-tail'].map(message))

    // Keep hasMore true so only the contiguity check can reject the interleaved row.
    const replay = [message('shared'), message('compacted-summary'), message('old-tail')]
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'snapshot', messages: replay, hasMore: true, beforeOffset: 9 },
        limit: 100,
        replaceSnapshot: false
      })
    ).toEqual({
      kind: 'messages',
      messages: replay,
      hasMore: true,
      beforeOffset: 9,
      windowReplaced: true
    })
  })

  it('replaces a replay that repeats retained ids out of order', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, ['a', 'b', 'c'].map(message))

    const replay = [message('a'), message('c'), message('b')]
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'snapshot', messages: replay, hasMore: true, beforeOffset: 4 },
        limit: 100,
        replaceSnapshot: false
      })
    ).toEqual({
      kind: 'messages',
      messages: replay,
      hasMore: true,
      beforeOffset: 4,
      windowReplaced: true
    })
  })

  it('replaces a replay that stops short of the retained newest row', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, ['a', 'b', 'c'].map(message))

    const replay = [message('a'), message('b')]
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'snapshot', messages: replay, hasMore: true, beforeOffset: 1 },
        limit: 100,
        replaceSnapshot: false
      })
    ).toEqual({
      kind: 'messages',
      messages: replay,
      hasMore: true,
      beforeOffset: 1,
      windowReplaced: true
    })
  })

  it('replaces retained history when replay metadata says no earlier rows remain', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, ['removed-1', 'removed-2', 'a', 'b'].map(message))

    const replay = [message('a'), message('b')]
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'snapshot', messages: replay, hasMore: false, beforeOffset: 0 },
        limit: 100,
        replaceSnapshot: false
      })
    ).toEqual({
      kind: 'messages',
      messages: replay,
      hasMore: false,
      beforeOffset: 0,
      windowReplaced: true
    })
  })

  it('replaces retained history when a single row precedes an authoritative replay', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, ['removed-1', 'a', 'b'].map(message))

    const replay = [message('a'), message('b')]
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'snapshot', messages: replay, hasMore: false, beforeOffset: 0 },
        limit: 100,
        replaceSnapshot: false
      })
    ).toEqual({
      kind: 'messages',
      messages: replay,
      hasMore: false,
      beforeOffset: 0,
      windowReplaced: true
    })
  })

  it('keeps the pagination cursor when an append does not trim history', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, [message('a')])

    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'appended', messages: [message('b')] },
        limit: 3,
        replaceSnapshot: false
      })
    ).toEqual({ kind: 'messages', messages: [message('a'), message('b')] })
  })

  it('replaces stale history for an explicit transcript replacement frame', () => {
    const merger = createNativeChatMerger()
    replaceList(merger, [message('old')])

    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'replacement', messages: [message('new')], hasMore: false },
        limit: 40,
        replaceSnapshot: false
      })
    ).toEqual({
      kind: 'messages',
      messages: [message('new')],
      hasMore: false,
      windowReplaced: true
    })
  })

  it('still treats the base snapshot as authoritative after a replacement frame', () => {
    const merger = createNativeChatMerger()
    applyMobileNativeChatStreamFrame({
      merger,
      frame: { type: 'replacement', messages: ['a', 'b'].map(message) },
      limit: 100,
      replaceSnapshot: true
    })

    // Replacement frames do not count as the subscription’s initial snapshot; the first snapshot must still replace.
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: {
          type: 'snapshot',
          messages: [message('b'), message('c')],
          hasMore: true,
          beforeOffset: 77
        },
        limit: 100,
        replaceSnapshot: true
      })
    ).toEqual({
      kind: 'messages',
      messages: [message('b'), message('c')],
      hasMore: true,
      beforeOffset: 77,
      windowReplaced: true
    })
  })

  it('surfaces snapshot errors, reports a host end as an error, and ignores unrelated frames', () => {
    const merger = createNativeChatMerger()
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'snapshot', error: 'Transcript unavailable' },
        limit: 40,
        replaceSnapshot: true
      })
    ).toEqual({ kind: 'error', error: 'Transcript unavailable' })
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'error', message: 'Socket closed' },
        limit: 40,
        replaceSnapshot: false
      })
    ).toEqual({ kind: 'error', error: 'Socket closed' })
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'end' },
        limit: 40,
        replaceSnapshot: true
      })
    ).toEqual({ kind: 'error', error: 'Transcript stream ended' })
    expect(
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type: 'subscribed' },
        limit: 40,
        replaceSnapshot: true
      })
    ).toEqual({ kind: 'ignored' })
  })
})

it('retains reader-produced tied image pages through prepend, append and reconnect into bubbles', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { readNativeChatTranscriptTail } =
    await import('../../../src/main/native-chat/transcript-tail-reader')
  const { foldMobileNativeChatMessages } = await import('./mobile-native-chat-render-data')
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
          JSON.stringify({
            type: 'user',
            uuid: id,
            timestamp: '2026-06-01T10:00:00Z',
            message: { role: 'user', content: text }
          }) + '\n'
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
