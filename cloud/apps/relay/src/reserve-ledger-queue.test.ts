import { describe, expect, it, vi } from 'vitest'
import type { RelayDatabase } from './database.js'
import { ReserveLedgerWriter, type LedgerEntry } from './reserve-ledger-writer.js'

const entry = (epoch: number): LedgerEntry => ({
  userId: 'user',
  relayHostId: `host-${epoch}`,
  cellId: 'c1',
  epoch
})

function recordingDatabase() {
  const epochs: number[][] = []
  const query = vi.fn(async (_sql: string, params: unknown[] = []) => {
    epochs.push(params.filter((_value, index) => index % 6 === 3).map(Number))
    return []
  })
  const database: RelayDatabase = {
    query,
    queryLocked: query,
    transaction: async (operation) => await operation(database),
    close: async () => {}
  }
  return { database, epochs, query }
}

describe('reserve ledger queue', () => {
  it('keeps FIFO batches and the newest bounded backlog through wraparound and reuse', async () => {
    const { database, epochs } = recordingDatabase()
    const writer = new ReserveLedgerWriter(database, { queueMax: 1_000, log: () => {} })
    for (let epoch = 0; epoch < 1_250; epoch++) writer.enqueue(entry(epoch))
    expect(writer.pending()).toBe(1_000)
    await writer.flush()
    expect(epochs[0]).toEqual(Array.from({ length: 500 }, (_, index) => index + 250))
    for (let epoch = 1_250; epoch < 1_600; epoch++) writer.enqueue(entry(epoch))
    expect(writer.pending()).toBe(850)
    await writer.flush()
    await writer.flush()
    expect(epochs[1]).toEqual(Array.from({ length: 500 }, (_, index) => index + 750))
    expect(epochs[2]).toEqual(Array.from({ length: 350 }, (_, index) => index + 1_250))
    expect(writer.pending()).toBe(0)
    writer.enqueue(entry(2_000))
    await writer.flush()
    expect(epochs[3]).toEqual([2_000])
  })

  it('keeps a wrapped batch for retry and does not start a second concurrent write', async () => {
    const { database, epochs, query } = recordingDatabase()
    let now = 1_000
    const writer = new ReserveLedgerWriter(database, {
      queueMax: 750,
      now: () => now,
      log: () => {}
    })
    for (let epoch = 0; epoch < 1_000; epoch++) writer.enqueue(entry(epoch))
    query.mockRejectedValueOnce(new Error('database unavailable'))
    await writer.flush()
    expect(writer.pending()).toBe(750)
    await writer.flush()
    expect(query).toHaveBeenCalledTimes(1)
    now += 1_000
    let finish: () => void = () => {}
    query.mockImplementationOnce(async (_sql, params = []) => {
      epochs.push(params.filter((_value, index) => index % 6 === 3).map(Number))
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return []
    })
    const flush = writer.flush()
    await writer.flush()
    expect(query).toHaveBeenCalledTimes(2)
    finish()
    await flush
    expect(epochs[0]).toEqual(Array.from({ length: 500 }, (_, index) => index + 250))
    expect(writer.pending()).toBe(250)
    await writer.flush()
    expect(epochs[1]).toEqual(Array.from({ length: 250 }, (_, index) => index + 750))
    expect(writer.pending()).toBe(0)
  })

  it('does not move a capped backlog for every newly booked host', () => {
    const { database } = recordingDatabase()
    const capacity = 4_000
    const writer = new ReserveLedgerWriter(database, { queueMax: capacity, log: () => {} })
    for (let epoch = 0; epoch < capacity; epoch++) writer.enqueue(entry(epoch))
    const splice = vi.spyOn(Array.prototype, 'splice')
    let frontRemovals = 0
    try {
      for (let epoch = capacity; epoch < capacity + 1_024; epoch++) writer.enqueue(entry(epoch))
      frontRemovals = splice.mock.calls.filter(([start]) => start === 0).length
    } finally {
      splice.mockRestore()
    }
    expect(writer.pending()).toBe(capacity)
    expect(frontRemovals * (capacity - 1)).toBe(0)
  })

  it('bounds backing slots and clears references as entries leave', async () => {
    const { database } = recordingDatabase()
    const capacity = 1_000
    const writer = new ReserveLedgerWriter(database, { queueMax: capacity, log: () => {} })
    const retained = () => {
      const ledger: unknown = writer
      if (typeof ledger !== 'object' || ledger === null || !('queue' in ledger)) {
        throw new Error('ledger queue is missing')
      }
      const queue = ledger.queue
      if (!Array.isArray(queue)) throw new Error('ledger queue is missing')
      expect(queue.length).toBeLessThanOrEqual(capacity)
      return queue.filter((value) => value !== undefined).length
    }
    for (let epoch = 0; epoch < 2_000; epoch++) writer.enqueue(entry(epoch))
    expect(retained()).toBe(1_000)
    await writer.flush()
    expect(retained()).toBe(500)
    for (let epoch = 2_000; epoch < 3_000; epoch++) writer.enqueue(entry(epoch))
    expect(retained()).toBe(1_000)
    await writer.flush()
    await writer.flush()
    expect(retained()).toBe(0)
  })

  it('keeps writes queued during an in-flight batch and reports the same totals', async () => {
    const { database, epochs, query } = recordingDatabase()
    let now = 0
    const log = vi.fn()
    const writer = new ReserveLedgerWriter(database, { queueMax: 1_000, now: () => now, log })
    for (let epoch = 0; epoch < 1_100; epoch++) writer.enqueue(entry(epoch))
    await writer.flush()
    let finish: () => void = () => {}
    query.mockImplementationOnce(async (_sql, params = []) => {
      epochs.push(params.filter((_value, index) => index % 6 === 3).map(Number))
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return []
    })
    const flush = writer.flush()
    for (let epoch = 1_100; epoch < 1_300; epoch++) writer.enqueue(entry(epoch))
    finish()
    await flush
    expect(writer.pending()).toBe(200)
    now = 60_000
    await writer.flush()
    expect(epochs[2]).toEqual(Array.from({ length: 200 }, (_, index) => index + 1_100))
    expect(JSON.parse(log.mock.calls[0]?.[0] ?? '')).toMatchObject({
      pending: 0,
      written: 1_200,
      dropped: 100,
      failures: 0
    })
  })

  it('preserves a disabled queue and its drop summary', async () => {
    const { database, query } = recordingDatabase()
    let now = 0
    const log = vi.fn()
    const writer = new ReserveLedgerWriter(database, { queueMax: 0, now: () => now, log })
    writer.enqueue(entry(1))
    writer.enqueue(entry(2))
    now = 60_000
    await writer.flush()
    expect(writer.pending()).toBe(0)
    expect(query).not.toHaveBeenCalled()
    expect(JSON.parse(log.mock.calls[0]?.[0] ?? '')).toMatchObject({ pending: 0, dropped: 2 })
  })

  it('preserves current-head removal when overflow evicts entries in an in-flight batch', async () => {
    const { database, epochs, query } = recordingDatabase()
    const writer = new ReserveLedgerWriter(database, { queueMax: 750, log: () => {} })
    for (let epoch = 0; epoch < 750; epoch++) writer.enqueue(entry(epoch))
    let finish: () => void = () => {}
    query.mockImplementationOnce(async (_sql, params = []) => {
      epochs.push(params.filter((_value, index) => index % 6 === 3).map(Number))
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return []
    })
    const flush = writer.flush()
    for (let epoch = 750; epoch < 1_150; epoch++) writer.enqueue(entry(epoch))
    expect(writer.pending()).toBe(750)
    finish()
    await flush
    expect(epochs[0]).toEqual(Array.from({ length: 500 }, (_, index) => index))
    expect(writer.pending()).toBe(250)
    await writer.flush()
    expect(epochs[1]).toEqual(Array.from({ length: 250 }, (_, index) => index + 900))
    expect(writer.pending()).toBe(0)
  })
})
