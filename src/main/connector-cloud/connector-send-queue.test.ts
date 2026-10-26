import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorFailure } from './connector-cloud-request'
import { ConnectorSendQueue, type ConnectorBatchSender } from './connector-send-queue'

const TOO_MANY: ConnectorFailure = { ok: false, status: 429, error: null, retryAfterMs: 300_000 }

function recordingSender(answer: () => Promise<ConnectorFailure | null>) {
  const batches: string[][] = []
  const sender: ConnectorBatchSender<string> = (batch) => {
    batches.push(batch)
    return answer()
  }
  return { sender, batches }
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
      // Accepted: only 'b' is left to send. Refused: the replacement resends both.
      expect(replacement.batches).toEqual([answer ? ['a', 'b'] : ['b']])
    }
  )

  it('keeps a pending Retry-After when the same sender is attached again', async () => {
    const queue = new ConnectorSendQueue<string>({ maxBatch: 10, random: () => 0.5 })
    const refusing = recordingSender(async () => TOO_MANY)
    queue.attach(refusing.sender)
    queue.push('a')
    await vi.advanceTimersByTimeAsync(0)
    queue.attach(refusing.sender)
    queue.push('b')
    await vi.advanceTimersByTimeAsync(299_000)
    expect(refusing.batches).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(refusing.batches).toEqual([['a'], ['a', 'b']])
  })
})
