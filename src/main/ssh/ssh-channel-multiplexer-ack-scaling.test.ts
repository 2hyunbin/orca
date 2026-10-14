import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshChannelMultiplexer, type MultiplexerTransport } from './ssh-channel-multiplexer'
import { encodeJsonRpcFrame, encodeKeepAliveFrame, MessageType } from './relay-protocol'

class CountingTimestampMap extends Map<number, number> {
  visits = 0

  override keys(): MapIterator<number> {
    const iterator = super.keys()
    const next = iterator.next.bind(iterator)
    iterator.next = () => {
      const result = next()
      if (!result.done) {
        this.visits++
      }
      return result
    }
    return iterator
  }
}

function createHarness(onWrite: (frame: Buffer) => void = () => {}): {
  mux: SshChannelMultiplexer
  timestamps: CountingTimestampMap
  receive: (frame: Buffer) => void
} {
  let receive = (_frame: Buffer): void => {}
  const transport: MultiplexerTransport = {
    write: onWrite,
    onClose: () => {},
    onData: (callback) => {
      receive = callback
    }
  }
  const mux = new SshChannelMultiplexer(transport)
  const timestamps = new CountingTimestampMap()
  const census: unknown = mux
  if (
    typeof census !== 'object' ||
    census === null ||
    !('unackedTimestamps' in census) ||
    !(census.unackedTimestamps instanceof Map)
  ) {
    throw new Error('The timestamp census must observe the production map')
  }
  census.unackedTimestamps = timestamps
  return { mux, timestamps, receive }
}

function referenceAcknowledge(timestamps: Map<number, number>, ack: number): void {
  for (const seq of timestamps.keys()) {
    if (seq <= ack) {
      timestamps.delete(seq)
    }
  }
}

describe('SSH acknowledgement scaling', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it.each([64, 256, 1024, 4095])(
    'visits each acknowledged timestamp and at most one later timestamp per ACK at %i sends',
    (count) => {
      vi.useFakeTimers()
      const { mux, timestamps, receive } = createHarness()
      const seen: number[] = []
      mux.onNotification((_method, params) => {
        if (typeof params.index !== 'number') {
          throw new Error('Missing notification index')
        }
        seen.push(params.index)
      })
      try {
        for (let index = 1; index <= count; index++) {
          mux.notify('pty.ackData', { acknowledgements: [] })
        }
        expect(timestamps.size).toBe(count)
        const reference = new Map(timestamps)
        for (let index = 1; index <= count; index++) {
          receive(
            encodeJsonRpcFrame(
              { jsonrpc: '2.0', method: 'pty.data', params: { index } },
              index,
              index
            )
          )
          referenceAcknowledge(reference, index)
          expect(new Map(timestamps)).toEqual(reference)
        }
        expect(seen).toEqual(Array.from({ length: count }, (_, index) => index + 1))
        expect(timestamps.visits).toBe(count * 2 - 1)
      } finally {
        mux.dispose()
      }
    }
  )

  it('preserves ACK gaps, duplicate and descending ACKs, cap gaps and an oversized ACK', () => {
    vi.useFakeTimers()
    const { mux, timestamps, receive } = createHarness()
    try {
      for (let index = 1; index <= 5000; index++) {
        mux.notify('bounded')
      }
      void mux.probeLiveness(60_000)
      expect(timestamps.size).toBe(4096)
      expect(timestamps.has(5001)).toBe(true)
      const reference = new Map(timestamps)
      for (const ack of [0, 17, 17, 5, 3000, 4095, 4800, 0xffffffff]) {
        receive(encodeKeepAliveFrame(1, ack))
        referenceAcknowledge(reference, Math.min(ack, 5001))
        expect(new Map(timestamps)).toEqual(reference)
        expect(mux.isDisposed()).toBe(false)
      }
      expect(timestamps.size).toBe(0)
    } finally {
      mux.dispose()
    }
  })

  it('preserves a synchronous reentrant transport that inserts a keepalive out of order', () => {
    vi.useFakeTimers()
    let reenter = (): void => {}
    const { mux, timestamps, receive } = createHarness((frame) => {
      if (frame[0] === MessageType.KeepAlive) {
        reenter()
      }
    })
    reenter = () => {
      mux.notify('reentrant-one')
      receive(encodeKeepAliveFrame(1, 1))
      mux.notify('reentrant-two')
      mux.notify('reentrant-three')
    }
    try {
      void mux.probeLiveness(60_000)
      expect([...timestamps.keys()]).toEqual([2, 3, 1])
      const reference = new Map(timestamps)
      for (const ack of [2, 3, 0xffffffff]) {
        receive(encodeKeepAliveFrame(1, ack))
        referenceAcknowledge(reference, ack)
        expect(new Map(timestamps)).toEqual(reference)
      }
    } finally {
      mux.dispose()
    }
  })
})
