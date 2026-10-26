import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorFailure } from './connector-cloud-request'
import { ConnectorSendQueue, type ConnectorBatchSender } from './connector-send-queue'

const TOO_MANY: ConnectorFailure = { ok: false, status: 429, error: null, retryAfterMs: 300_000 }

function recordingSender(answer: () => Promise<ConnectorFailure | null>) {
  const batches: string[][] = []
  const seqs: number[] = []
  const sender: ConnectorBatchSender<string> = (batch, seq) => {
    batches.push(batch)
    seqs.push(seq)
    return answer()
  }
  return { sender, batches, seqs }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ConnectorSendQueue', () => {
  it.each([
    ['accepted', null],
    ['refused', TOO_MANY]
  ] as const)(
    'hands queued items to a sender attached while a retired one was %s mid-request',
    async (_, answer) => {
      const queue = new ConnectorSendQueue<string>({ maxBatch: 10, random: () => 0.5 })
      const held = Promise.withResolvers<ConnectorFailure | null>()
      const retired = recordingSender(() => held.promise)
      const replacement = recordingSender(async () => null)
      queue.attach(retired.sender)
      queue.push('a')
      queue.detach(retired.sender)
      queue.attach(replacement.sender)
      queue.push('b')
      held.resolve(answer)
      await vi.advanceTimersByTimeAsync(0)
      // Refused: the replacement resends the frozen batch, same number, before anything later.
      expect(replacement.batches).toEqual(answer ? [['a'], ['b']] : [['b']])
      expect(replacement.seqs).toEqual(answer ? [0, 1] : [1])
    }
  )

  it('keeps a pending Retry-After when the same sender is attached again', async () => {
    const queue = new ConnectorSendQueue<string>({ maxBatch: 10, random: () => 0.5 })
    let refuse = true
    const sender = recordingSender(async () => (refuse ? TOO_MANY : null))
    queue.attach(sender.sender)
    queue.push('a')
    await vi.advanceTimersByTimeAsync(0)
    queue.attach(sender.sender)
    queue.push('b')
    await vi.advanceTimersByTimeAsync(299_000)
    expect(sender.batches).toHaveLength(1)
    refuse = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sender.batches).toEqual([['a'], ['a'], ['b']])
  })

  it('never lets a later item overtake a refused one: the retry resends the same batch and number', async () => {
    const queue = new ConnectorSendQueue<string>({ maxBatch: 2, random: () => 0.5 })
    const answers: (ConnectorFailure | null)[] = [TOO_MANY, null, null]
    const sender = recordingSender(async () => answers.shift() ?? null)
    queue.attach(sender.sender)
    queue.push('old prompt')
    await vi.advanceTimersByTimeAsync(0)
    queue.push('linked', 'new prompt')
    await vi.advanceTimersByTimeAsync(300_000)
    expect(sender.batches).toEqual([['old prompt'], ['old prompt'], ['linked', 'new prompt']])
    expect(sender.seqs).toEqual([0, 0, 1])
  })

  it('restarts numbering with its first batch in front, keeping only what is still wanted', async () => {
    const queue = new ConnectorSendQueue<string>({ maxBatch: 10, random: () => 0.5 })
    let refuse = true
    const sender = recordingSender(async () => (refuse ? TOO_MANY : null))
    queue.attach(sender.sender)
    queue.push('turn end', 'prompt')
    await vi.advanceTimersByTimeAsync(0)
    refuse = false
    queue.restart(['snapshot'], (item) => item === 'turn end')
    await vi.advanceTimersByTimeAsync(0)
    expect(sender.batches.at(-1)).toEqual(['snapshot', 'turn end'])
    expect(sender.seqs.at(-1)).toBe(0)
  })
})
