import { describe, expect, it, vi } from 'vitest'
import { BridgeTerminalOutputBacklog } from './bridge-terminal-output-backlog'

function backlogWithClock() {
  let armed = false
  const backlog = new BridgeTerminalOutputBacklog({
    onAckSilence: () => {
      throw new Error('Unexpected acknowledgement timeout')
    },
    timers: {
      set: () => {
        armed = true
        return 1
      },
      clear: () => {
        armed = false
      }
    }
  })
  return { backlog, armed: () => armed }
}

function output(chunk: string) {
  return { type: 'data', streamId: 1, chunk }
}

function backlogStorage(backlog: BridgeTerminalOutputBacklog): unknown[] {
  const slots: unknown = Object.getOwnPropertyDescriptor(backlog, 'queue')?.value
  if (!Array.isArray(slots)) {
    throw new Error('Expected terminal backlog storage')
  }
  return slots
}

describe('terminal backlog queue drain', () => {
  it('drains fragmented output without moving the remaining queue once per chunk', () => {
    const { backlog, armed } = backlogWithClock()
    const chunks = Array.from({ length: 32_768 }, (_, index) => `${index}\n`)
    for (const chunk of chunks) {
      expect(backlog.hold(output(chunk))).toBe(true)
    }
    const frames: unknown[] = []
    const storage = backlogStorage(backlog)
    const shifted = vi.spyOn(storage, 'shift')
    const compacted = vi.spyOn(storage, 'splice')
    let shifts: number
    let compactions: number
    let pendingAfterDrain = Number.POSITIVE_INFINITY
    let armedAfterDrain = true
    try {
      while (backlog.held) {
        frames.push(backlog.next(1024, true))
      }
      shifts = shifted.mock.calls.length
      compactions = compacted.mock.calls.length
      pendingAfterDrain = backlog.pendingBytes
      armedAfterDrain = armed()
    } finally {
      shifted.mockRestore()
      compacted.mockRestore()
      backlog.dispose()
    }
    const delivered = frames.map((frame) => {
      if (!frame || typeof frame !== 'object' || !('chunk' in frame)) {
        throw new Error('Expected terminal output')
      }
      return frame.chunk
    })
    expect(delivered.join('')).toBe(chunks.join(''))
    expect(pendingAfterDrain).toBe(0)
    expect(armedAfterDrain).toBe(false)
    expect(backlog.pendingBytes).toBe(0)
    expect(armed()).toBe(false)
    expect(shifts).toBe(0)
    expect(compactions).toBeLessThanOrEqual(Math.ceil(Math.log2(chunks.length)))
  })

  it('preserves ordering, byte accounting and timeout ownership after partial drains and appends', () => {
    const { backlog, armed } = backlogWithClock()
    const initial = Array.from({ length: 1024 }, (_, index) => ({
      type: 'metadata',
      streamId: 1,
      title: `row-${index}`
    }))
    let remainingBytes = 0
    for (const payload of initial) {
      backlog.hold(payload)
      remainingBytes += JSON.stringify(payload).length
    }
    for (const payload of initial.slice(0, 700)) {
      expect(backlog.next(1024, true)).toBe(payload)
      remainingBytes -= JSON.stringify(payload).length
      expect(backlog.pendingBytes).toBe(remainingBytes)
    }
    expect(backlog.held).toBe(true)
    expect(armed()).toBe(true)
    backlog.noteAck()
    const tail = [output('before\ud83d'), output(''), output('\ude00after')]
    for (const payload of tail) {
      backlog.hold(payload)
    }
    for (const payload of initial.slice(700)) {
      expect(backlog.next(1024, true)).toBe(payload)
    }
    expect(backlog.next(1024, true)).toEqual(output('before😀after'))
    expect(backlog.held).toBe(false)
    expect(backlog.pendingBytes).toBe(0)
    expect(armed()).toBe(false)
    backlog.hold(output('after-drain'))
    expect(armed()).toBe(true)
    expect(backlog.next(1024, true)).toEqual(output('after-drain'))
    backlog.hold(output('dispose'))
    backlog.dispose()
    expect(backlog.next(1024, true)).toBeNull()
    expect(backlog.pendingBytes).toBe(0)
    expect(armed()).toBe(false)
  })

  it('releases drained payload references before the next compaction', () => {
    const { backlog } = backlogWithClock()
    const payloads = Array.from({ length: 512 }, (_, index) => ({
      type: 'metadata',
      title: `payload-${index}`
    }))
    for (const payload of payloads) {
      backlog.hold(payload)
    }
    const consumed = new Set<unknown>(payloads.slice(0, 64))
    for (const payload of consumed) {
      expect(backlog.next(1024, true)).toBe(payload)
    }
    // Count backing references, because pendingBytes alone cannot reveal retained payloads.
    for (const entry of backlogStorage(backlog)) {
      if (entry !== null && typeof entry === 'object' && 'payload' in entry) {
        expect(consumed.has(entry.payload)).toBe(false)
      }
    }
    for (const payload of payloads.slice(64)) {
      expect(backlog.next(1024, true)).toBe(payload)
    }
    expect(backlog.pendingBytes).toBe(0)
    backlog.dispose()
  })
})
