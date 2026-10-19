// Why: this is the original Unix socket / named pipe transport extracted from
// runtime-rpc.ts. It preserves the exact same behavior: newline-delimited JSON,
// 30s idle timeout (suspended while a dispatch is in flight), 1MB max message,
// 512-connection budget (hard limit 640), chmod 0o600 on Unix.
// It also owns the keepalive timer and per-connection abort signal so the
// server-side handler can cancel long-poll dispatches when the client goes
// away. See design doc §3.1.
import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, existsSync, rmSync } from 'node:fs'
import type { RpcMessageContext, RpcTransport } from './transport'
import { MAX_LONG_POLLS_PER_CONNECTION } from '../runtime-rpc/runtime-rpc-long-poll'

const MAX_RUNTIME_RPC_MESSAGE_BYTES = 1024 * 1024
const RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS = 30_000
// Why: long-polls take no slot, so each held one keeps a socket open. Past this budget a long-poll gets a
// retryable runtime_busy (not a silent drop that reads as "Restart Orca") and the socket closes after its reply.
export const RUNTIME_RPC_CONNECTION_BUDGET = 512
// Why: the hard fd bound; past the budget only short or idle sockets remain, so this headroom is rarely reached.
const HARD_CONNECTION_HEADROOM = 128
const DEFAULT_KEEPALIVE_INTERVAL_MS = 10_000

export type UnixSocketTransportOptions = {
  endpoint: string
  kind: 'unix' | 'named-pipe'
  // Why: how often to write `{"_keepalive":true}\n` frames while a dispatch
  // is pending. Each write resets both the server-side idle timer and, once
  // the client honours them, the client-side idle timer. Tests override this
  // to avoid waiting 10 s for a frame.
  keepaliveIntervalMs?: number
  connectionBudget?: number
}

type MessageHandler = (
  msg: string,
  reply: (response: string) => void,
  context?: RpcMessageContext
) => void

export class UnixSocketTransport implements RpcTransport {
  private readonly endpoint: string
  private readonly kind: 'unix' | 'named-pipe'
  private readonly keepaliveIntervalMs: number
  private readonly connectionBudget: number
  private server: Server | null = null
  private messageHandler: MessageHandler | null = null
  private readonly activeSockets = new Set<Socket>()

  constructor({
    endpoint,
    kind,
    keepaliveIntervalMs,
    connectionBudget
  }: UnixSocketTransportOptions) {
    this.endpoint = endpoint
    this.kind = kind
    this.keepaliveIntervalMs = keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS
    this.connectionBudget = connectionBudget ?? RUNTIME_RPC_CONNECTION_BUDGET
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  async start(): Promise<void> {
    if (this.server) {
      return
    }

    if (this.kind === 'unix' && existsSync(this.endpoint)) {
      rmSync(this.endpoint, { force: true })
    }

    const server = createServer((socket) => {
      this.handleConnection(socket)
    })
    server.maxConnections = this.connectionBudget + HARD_CONNECTION_HEADROOM

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.endpoint, () => {
        server.off('error', reject)
        resolve()
      })
    })
    // Why: an accept failure (EMFILE when the process is out of fds) would otherwise be an unhandled
    // 'error' that crashes the runtime; dropping that one connection is the safe outcome.
    server.on('error', (error) => {
      console.warn('[unix-socket-transport] accept failed:', error)
    })

    if (this.kind === 'unix') {
      chmodSync(this.endpoint, 0o600)
    }

    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) {
      return
    }
    const closePromise = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    // Why: server.close() stops accepting new connections but waits for
    // existing sockets; long-poll keepalives can otherwise hold shutdown open.
    for (const socket of Array.from(this.activeSockets)) {
      socket.destroy()
    }
    await closePromise
    if (this.kind === 'unix' && existsSync(this.endpoint)) {
      rmSync(this.endpoint, { force: true })
    }
  }

  private handleConnection(socket: Socket): void {
    this.activeSockets.add(socket)
    const overConnectionBudget = this.activeSockets.size > this.connectionBudget
    // Why per connection: one socket can pipeline requests, so the socket budget alone doesn't bound held handlers.
    const longPolls = { held: 0, overConnectionBudget }
    let buffer = ''
    let retainedBytes = 0
    let oversized = false
    // Why: each in-flight dispatch registers its own AbortController here so
    // `socket.on('close')` can abort them all at once. Keeping the set scoped
    // to the connection (rather than a single shared controller) means
    // completing one dispatch does not abort any other dispatch still running
    // on the same socket — future-proofing for a persistent CLI socket that
    // multiplexes sequential requests.
    const inflight = new Set<() => void>()
    // Why: Node's idle timer counts raw byte silence, so a slow dispatch (e.g.
    // worktree.create on a large repo) reads as a dead peer and gets reaped.
    // Suspend the reap while dispatches are pending; quiet connections without
    // dispatches still reap after the timeout. On a local socket the kernel
    // delivers close for a dead peer, so nothing else relied on byte silence.
    const rearmIdleTimer = (): void => {
      if (!socket.destroyed) {
        socket.setTimeout(inflight.size > 0 ? 0 : RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS)
      }
    }

    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    socket.setTimeout(RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS, () => {
      socket.destroy()
    })
    socket.on('error', () => {
      socket.destroy()
    })
    socket.once('close', () => {
      for (const cleanup of inflight) {
        cleanup()
      }
      inflight.clear()
      this.activeSockets.delete(socket)
    })
    socket.on('data', (chunk: string) => {
      if (oversized) {
        return
      }
      buffer += chunk
      // setEncoding('utf8') keeps split codepoints intact, so chunk byte lengths add exactly.
      retainedBytes += Buffer.byteLength(chunk, 'utf8')
      // Why: the Orca runtime lives in Electron main, so it must reject
      // oversized local RPC frames instead of letting a local client grow an
      // unbounded buffer and stall the app.
      if (retainedBytes > MAX_RUNTIME_RPC_MESSAGE_BYTES) {
        oversized = true
        this.messageHandler?.('', (response) => {
          socket.write(`${response}\n`)
          socket.end()
        })
        return
      }
      if (!chunk.includes('\n')) {
        return
      }
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const rawMessage = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (rawMessage) {
          this.dispatchMessage(socket, rawMessage, inflight, rearmIdleTimer, longPolls)
        }
        newlineIndex = buffer.indexOf('\n')
      }
      retainedBytes = Buffer.byteLength(buffer, 'utf8')
    })
  }

  // Why: the keepalive timer is opt-in per request via `startKeepalive()`.
  // Short RPCs never call it and pay no timer overhead; only long-poll
  // handlers (e.g. orchestration.check --wait) arm it. See §3.1.
  private dispatchMessage(
    socket: Socket,
    rawMessage: string,
    inflight: Set<() => void>,
    rearmIdleTimer: () => void,
    longPolls: { held: number; overConnectionBudget: boolean }
  ): void {
    let replied = false
    let keepaliveTimer: NodeJS.Timeout | null = null
    // Why: each dispatch needs its own abort signal and keepalive timer
    // cleanup. Socket close runs every cleanup without touching sibling
    // dispatches that already replied on the same connection.
    const abortController = new AbortController()
    let cleanedUp = false
    let holdsLongPoll = false
    const cleanupDispatch = (abort: boolean): void => {
      if (cleanedUp) {
        return
      }
      cleanedUp = true
      if (holdsLongPoll) {
        holdsLongPoll = false
        longPolls.held -= 1
      }
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
      }
      if (abort) {
        abortController.abort()
      }
      inflight.delete(abortDispatch)
      rearmIdleTimer()
    }
    const abortDispatch = (): void => cleanupDispatch(true)
    inflight.add(abortDispatch)
    rearmIdleTimer()

    const reply = (response: string): void => {
      if (replied) {
        return
      }
      replied = true
      cleanupDispatch(false)
      if (!socket.destroyed && socket.writable) {
        socket.write(`${response}\n`)
        if (longPolls.overConnectionBudget) {
          socket.end()
        }
      }
    }

    const holdLongPoll = (): boolean => {
      if (
        cleanedUp ||
        longPolls.overConnectionBudget ||
        longPolls.held >= MAX_LONG_POLLS_PER_CONNECTION
      ) {
        return false
      }
      holdsLongPoll = true
      longPolls.held += 1
      return true
    }

    const startKeepalive = (): void => {
      if (keepaliveTimer || replied) {
        return
      }
      keepaliveTimer = setInterval(() => {
        if (replied || socket.destroyed || !socket.writable) {
          cleanupDispatch(socket.destroyed || !socket.writable)
          return
        }
        socket.write('{"_keepalive":true}\n')
      }, this.keepaliveIntervalMs)
      // Why: don't hold the process open solely on the keepalive interval.
      if (typeof keepaliveTimer.unref === 'function') {
        keepaliveTimer.unref()
      }
    }

    this.messageHandler?.(rawMessage, reply, {
      signal: abortController.signal,
      startKeepalive,
      holdLongPoll
    })
  }
}
