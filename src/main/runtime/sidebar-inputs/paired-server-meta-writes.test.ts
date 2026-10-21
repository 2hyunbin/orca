import { describe, expect, it } from 'vitest'
import { PairedServerMetaWrites } from './paired-server-meta-writes'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function freshReads() {
  const waiters: { environmentId: string; done: (read: boolean) => void }[] = []
  return {
    reads: {
      afterFreshRead: (environmentId: string, done: (read: boolean) => void) =>
        waiters.push({ environmentId, done })
    },
    waiters,
    answer: (read: boolean) => waiters.splice(0).forEach(({ done }) => done(read))
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const target = { environmentId: 'box', worktreeId: 'repo::/a' }
const ROW = 'runtime:box|repo::/a'

describe('PairedServerMetaWrites', () => {
  it('forwards one write per row and field at a time, in order', async () => {
    const { reads } = freshReads()
    const writes = new PairedServerMetaWrites(reads)
    const sent: string[] = []
    const first = deferred<string>()
    const pinned = writes.write(target, 'isPinned', () => {
      sent.push('pin')
      return first.promise
    })
    const unpinned = writes.write(target, 'isPinned', async () => {
      sent.push('unpin')
      return 'unpinned'
    })
    // Another field is its own line.
    const renamed = writes.write(target, 'displayName', async () => {
      sent.push('rename')
      return 'renamed'
    })
    await flush()
    expect(sent).toEqual(['pin', 'rename'])
    first.resolve('pinned')
    expect(await Promise.all([pinned, unpinned, renamed])).toEqual([
      'pinned',
      'unpinned',
      'renamed'
    ])
    expect(sent).toEqual(['pin', 'rename', 'unpin'])
  })

  it('reads saving until a fresh read after the reply, never on the reply itself', async () => {
    const { reads, waiters, answer } = freshReads()
    const writes = new PairedServerMetaWrites(reads)
    const reply = writes.write(target, 'isPinned', async () => 'ok')
    expect(writes.saving()).toEqual({ [ROW]: ['isPinned'] })
    await reply
    await flush()
    // The reply (or an echo of the value) settles nothing; only the fresh read does.
    expect(writes.saving()).toEqual({ [ROW]: ['isPinned'] })
    expect(waiters).toHaveLength(1)
    answer(true)
    expect(writes.saving()).toEqual({})
  })

  it('keeps an earlier write from settling a newer one of the same field', async () => {
    const { reads, answer } = freshReads()
    const writes = new PairedServerMetaWrites(reads)
    await writes.write(target, 'isPinned', async () => 'pin')
    await flush()
    const second = deferred<string>()
    const newer = writes.write(target, 'isPinned', () => second.promise)
    // The first write's fresh read answers while the second is still unanswered.
    answer(true)
    expect(writes.saving()).toEqual({ [ROW]: ['isPinned'] })
    second.resolve('unpin')
    await newer
    await flush()
    answer(true)
    expect(writes.saving()).toEqual({})
  })

  it('ends the hint when contact is lost or the write is refused', async () => {
    const { reads, answer } = freshReads()
    const writes = new PairedServerMetaWrites(reads)
    await writes.write(target, 'isPinned', async () => 'ok')
    await flush()
    answer(false)
    expect(writes.saving()).toEqual({})
    await expect(
      writes.write(target, 'isPinned', async () => {
        throw new Error('refused')
      })
    ).rejects.toThrow('refused')
    await flush()
    expect(writes.saving()).toEqual({})
  })
})
