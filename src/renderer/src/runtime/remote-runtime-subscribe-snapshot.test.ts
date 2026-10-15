import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import {
  getRemoteRuntimeTerminalMultiplexer,
  resetRemoteRuntimeTerminalMultiplexersForTests
} from './remote-runtime-terminal-multiplexer'
import type { RemoteRuntimeMultiplexedTerminal } from './remote-runtime-terminal-multiplexer-types'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

// Why: a park reveal used to pay the subscribe snapshot and then a second, serial
// SnapshotRequest for the same pane. These pin that a host which serves the
// subscribe-time request answers the reveal with ONE snapshot, and that an older
// host (no echo) still gets today's follow-up request.

type SubscribeCallbacks = {
  onResponse: (response: unknown) => void
  onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
}

class SubscribeSnapshotServer {
  private streamId = 0
  private seq = 0
  /** Old hosts drop the unknown subscribe field and never echo it. */
  servesSubscribeRequest = true
  holdInitial = false
  snapshotsSent = 0
  snapshotRequests = 0
  subscribeScrollbackRows: number | undefined
  private releaseInitial: (() => void) | null = null

  constructor(private readonly toClient: (bytes: Uint8Array<ArrayBufferLike>) => void) {}

  receive(bytes: Uint8Array<ArrayBufferLike>): void {
    const frame = decodeTerminalStreamFrame(bytes)
    if (!frame) {
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Subscribe) {
      const payload = decodeTerminalStreamJson<{
        streamId: number
        snapshotScrollbackRows?: number
      }>(frame.payload)
      this.streamId = payload?.streamId ?? 0
      this.subscribeScrollbackRows = payload?.snapshotScrollbackRows
      const rows = this.servesSubscribeRequest ? this.subscribeScrollbackRows : undefined
      const sendInitial = (): void =>
        this.sendSnapshot(
          rows === undefined ? 'DEFAULT-1000' : `HISTORY-${rows}`,
          rows === undefined ? {} : { requestedScrollbackRows: rows, scrollbackRows: rows }
        )
      if (this.holdInitial) {
        this.releaseInitial = sendInitial
      } else {
        sendInitial()
      }
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotRequest) {
      this.snapshotRequests += 1
      const request = decodeTerminalStreamJson<{ requestId: number; scrollbackRows?: number }>(
        frame.payload
      )
      this.sendSnapshot(`REQUESTED-${request?.scrollbackRows}`, { requestId: request?.requestId })
    }
  }

  flushInitial(): void {
    this.releaseInitial?.()
    this.releaseInitial = null
  }

  output(text: string): void {
    this.seq += text.length
    this.send(TerminalStreamOpcode.Output, encodeTerminalStreamText(text))
  }

  private sendSnapshot(data: string, meta: Record<string, unknown>): void {
    this.snapshotsSent += 1
    this.send(
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({ cols: 80, rows: 24, seq: this.seq, ...meta })
    )
    this.send(TerminalStreamOpcode.SnapshotChunk, encodeTerminalStreamText(data))
    this.send(TerminalStreamOpcode.SnapshotEnd, new Uint8Array())
  }

  private send(opcode: TerminalStreamOpcode, payload: Uint8Array): void {
    this.toClient(
      encodeTerminalStreamFrame({ opcode, streamId: this.streamId, seq: this.seq, payload })
    )
  }
}

describe('park-reveal snapshot folded into the subscribe snapshot', () => {
  let server: SubscribeSnapshotServer
  let configureServer: (next: SubscribeSnapshotServer) => void

  beforeEach(() => {
    resetRemoteRuntimeTerminalMultiplexersForTests()
    replaceRuntimeEnvironmentRevisions([])
    configureServer = () => {}
    stubRuntimeEnvironmentBridge({
      subscribe: vi.fn(async (_args: unknown, callbacks: SubscribeCallbacks) => {
        server = new SubscribeSnapshotServer((bytes) => callbacks.onBinary?.(bytes))
        configureServer(server)
        queueMicrotask(() => callbacks.onResponse({ ok: true, result: { type: 'ready' } }))
        return {
          unsubscribe: vi.fn(),
          sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => server.receive(bytes)
        }
      })
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function subscribe(
    snapshotScrollbackRows?: number,
    onSnapshot: (data: string) => void = () => {}
  ): Promise<RemoteRuntimeMultiplexedTerminal> {
    return getRemoteRuntimeTerminalMultiplexer('env-1').subscribeTerminal({
      terminal: 'terminal-1',
      client: { id: 'desktop-1', type: 'desktop' },
      ...(snapshotScrollbackRows === undefined ? {} : { snapshotScrollbackRows }),
      callbacks: { onData: () => {}, onSnapshot }
    })
  }

  it('answers the reveal from the subscribe snapshot: one snapshot, no SnapshotRequest', async () => {
    configureServer = (next) => {
      next.holdInitial = true
    }
    const painted: string[] = []
    const stream = await subscribe(5000, (data) => painted.push(data))
    // The reveal claims right after connect, before the host's snapshot lands.
    const reveal = stream.serializeBufferOutcome({ scrollbackRows: 5000 })
    server.flushInitial()

    const outcome = await reveal
    expect(outcome.availability).toEqual({ kind: 'snapshot' })
    expect(outcome.snapshot?.data).toBe('HISTORY-5000')
    expect(server.subscribeScrollbackRows).toBe(5000)
    expect(server.snapshotRequests).toBe(0)
    expect(server.snapshotsSent).toBe(1)
    // The pushed screen still reaches the pane exactly as before.
    expect(painted).toEqual(['HISTORY-5000'])
  })

  it('also serves a reveal that claims after the subscribe snapshot landed', async () => {
    const stream = await subscribe(5000)
    await Promise.resolve()
    await Promise.resolve()

    const outcome = await stream.serializeBufferOutcome({ scrollbackRows: 5000 })
    expect(outcome.snapshot?.data).toBe('HISTORY-5000')
    expect(server.snapshotRequests).toBe(0)
  })

  it('falls back to a SnapshotRequest when an older host does not echo the request', async () => {
    configureServer = (next) => {
      next.servesSubscribeRequest = false
      next.holdInitial = true
    }
    const stream = await subscribe(5000)
    const reveal = stream.serializeBufferOutcome({ scrollbackRows: 5000 })
    server.flushInitial()

    const outcome = await reveal
    expect(outcome.snapshot?.data).toBe('REQUESTED-5000')
    expect(server.snapshotRequests).toBe(1)
    expect(server.snapshotsSent).toBe(2)
  })

  it('keeps the follow-up request when the subscribe asked for nothing', async () => {
    const stream = await subscribe()
    await Promise.resolve()
    await Promise.resolve()

    const outcome = await stream.serializeBufferOutcome({ scrollbackRows: 5000 })
    expect(server.subscribeScrollbackRows).toBeUndefined()
    expect(outcome.snapshot?.data).toBe('REQUESTED-5000')
    expect(server.snapshotRequests).toBe(1)
  })

  it('never hands out a subscribe image that live output has already moved past', async () => {
    const stream = await subscribe(5000)
    await Promise.resolve()
    await Promise.resolve()
    server.output('later')

    const outcome = await stream.serializeBufferOutcome({ scrollbackRows: 5000 })
    expect(outcome.snapshot?.data).toBe('REQUESTED-5000')
    expect(server.snapshotRequests).toBe(1)
  })

  it('serves the subscribe image once; a different budget or a second caller asks the host', async () => {
    const stream = await subscribe(5000)
    await Promise.resolve()
    await Promise.resolve()

    await expect(stream.serializeBufferOutcome({ scrollbackRows: 1000 })).resolves.toMatchObject({
      snapshot: { data: 'REQUESTED-1000' }
    })
    await expect(stream.serializeBufferOutcome({ scrollbackRows: 5000 })).resolves.toMatchObject({
      snapshot: { data: 'REQUESTED-5000' }
    })
    expect(server.snapshotRequests).toBe(2)
  })
})
