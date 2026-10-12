/**
 * The minimum relay protocol needed to drive terminals an already-running older relay holds.
 * COMPAT(legacy-relay-bridge): remove after 2026-11-15.
 *
 * The old relay compares bundle hashes exactly, so this build's handshake is refused. Its own
 * `relay.js --connect`, run from its own version directory, presents its own hash, so any later
 * client reaches it. Nothing is ever deployed or started here: a relay that is not already
 * listening simply cannot be reached.
 */
import type { MultiplexerTransport } from '../ssh-channel-multiplexer'
import { SshChannelMultiplexer } from '../ssh-channel-multiplexer'

const PROTOCOL_VERSION = 1
const OPEN_CLIENT_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 15_000
// The relay's owner-claim errors (v1.4.2xx `pty-consumer-session-contract.ts`).
const OWNER_RECOVERY_PENDING = -32042
const OWNER_RECOVERY_SUPERSEDED = -32043
const OWNER_HELD_ATTACHED = -32044
const OWNER_HELD_DISCONNECTED = -32045
const OWNER_HELD_SELF = -32046
const METHOD_NOT_FOUND = -32601
// Longer than the relay's 30s owner grace, which a different client clamps to 250ms on asking.
const OWNER_RETRY_BUDGET_MS = 35_000

export type LegacyRelayOwnerClaim = { ownerGeneration: number; ownerLease: string }

export type LegacyRelayClientOptions = {
  /** `cd <relay-dir> && <node> relay.js --connect …`, already built for this endpoint. */
  connectCommand: string
  /** The version the old relay's handshake answers with (`<relay-dir>/.version`). */
  serverBuildId: string
  clientInstanceId: string
  /** A claim this client held before a drop, so the owner role resumes without waiting. */
  resume?: LegacyRelayOwnerClaim | null
  openTransport: (command: string) => Promise<MultiplexerTransport>
  /** Test seam for the owner-claim retry wait. */
  sleep?: (ms: number) => Promise<void>
}

/** Another client holds this relay's terminals while attached; never displaced. */
export class LegacyRelayOwnerHeldError extends Error {
  readonly code = 'legacy_relay_owner_held'
  constructor() {
    super('Another Orca client is attached to this relay')
  }
}

export type LegacyRelayPty = {
  relayPtyId: string
  cwd?: string
  title?: string
  worktreeId?: string
}

type DataListener = (relayPtyId: string, data: string) => void
type ExitListener = (relayPtyId: string, code: number) => void

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function parseOwnerGrant(value: unknown, serverBuildId: string): LegacyRelayOwnerClaim {
  const grant = typeof value === 'object' && value !== null ? value : {}
  const field = (name: string): unknown => (name in grant ? Reflect.get(grant, name) : undefined)
  const ownerGeneration = field('ownerGeneration')
  const ownerLease = field('ownerLease')
  if (
    field('protocolVersion') !== PROTOCOL_VERSION ||
    field('serverBuildId') !== serverBuildId ||
    field('role') !== 'session-owner' ||
    typeof ownerGeneration !== 'number' ||
    !Number.isSafeInteger(ownerGeneration) ||
    ownerGeneration <= 0 ||
    typeof ownerLease !== 'string' ||
    ownerLease.length === 0 ||
    ownerLease.length > 512
  ) {
    throw new Error('Older relay did not grant the terminal owner role')
  }
  return { ownerGeneration, ownerLease }
}

function parsePtyList(value: unknown): LegacyRelayPty[] {
  if (!Array.isArray(value)) {
    throw new Error('Older relay answered pty.listProcesses with something other than a list')
  }
  const rows: LegacyRelayPty[] = []
  for (const row of value) {
    const id: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'id') : null
    if (typeof id !== 'string' || id.length === 0) {
      continue
    }
    const cwd: unknown = Reflect.get(row, 'cwd')
    const title: unknown = Reflect.get(row, 'title')
    const worktreeId: unknown = Reflect.get(row, 'worktreeId')
    rows.push({
      relayPtyId: id,
      ...(typeof cwd === 'string' ? { cwd } : {}),
      ...(typeof title === 'string' ? { title } : {}),
      ...(typeof worktreeId === 'string' ? { worktreeId } : {})
    })
  }
  return rows
}

export class LegacyRelayClient {
  private readonly dataListeners = new Set<DataListener>()
  private readonly exitListeners = new Set<ExitListener>()
  private readonly closeListeners = new Set<() => void>()

  private constructor(
    private readonly mux: SshChannelMultiplexer,
    /** Null for a relay that predates owner claims (it serves any client). */
    readonly ownerClaim: LegacyRelayOwnerClaim | null
  ) {
    mux.onNotification((method, params) => this.route(method, params))
    mux.onDispose(() => this.closeListeners.forEach((listener) => listener()))
  }

  static async open(options: LegacyRelayClientOptions): Promise<LegacyRelayClient> {
    const mux = new SshChannelMultiplexer(await options.openTransport(options.connectCommand))
    try {
      const claim = await claimOwner(mux, options)
      return new LegacyRelayClient(mux, claim)
    } catch (error) {
      mux.dispose()
      throw error
    }
  }

  get closed(): boolean {
    return this.mux.isDisposed()
  }

  async list(): Promise<LegacyRelayPty[]> {
    return parsePtyList(
      await this.mux.request(
        'pty.listProcesses',
        { includeForegroundProcessEvidence: false },
        { timeoutMs: REQUEST_TIMEOUT_MS }
      )
    )
  }

  /** Resumes output for one PTY and returns its screen so far. Throws "not found" when it is gone. */
  async attach(relayPtyId: string): Promise<{ replay: string }> {
    const result = await this.mux.request(
      'pty.attach',
      { id: relayPtyId, suppressReplayNotification: true, requireReplay: true },
      { timeoutMs: REQUEST_TIMEOUT_MS }
    )
    const replay: unknown =
      typeof result === 'object' && result !== null ? Reflect.get(result, 'replay') : undefined
    return { replay: typeof replay === 'string' ? replay : '' }
  }

  write(relayPtyId: string, data: string): void {
    this.mux.notify('pty.data', { id: relayPtyId, data })
  }

  resize(relayPtyId: string, cols: number, rows: number): void {
    this.mux.notify('pty.resize', { id: relayPtyId, cols, rows })
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  /** Hangs up this client only; the relay keeps every terminal and its own grace decides the rest. */
  close(): void {
    this.mux.dispose()
  }

  private route(method: string, params: Record<string, unknown>): void {
    const id = params.id
    if (typeof id !== 'string' || id.length === 0) {
      return
    }
    if (method === 'pty.data' && typeof params.data === 'string') {
      const data = params.data
      this.dataListeners.forEach((listener) => listener(id, data))
    } else if (method === 'pty.exit') {
      const code = typeof params.code === 'number' ? params.code : -1
      this.exitListeners.forEach((listener) => listener(id, code))
    }
  }
}

/**
 * Asks for the owner role without output flow control, so the old relay publishes plain
 * `pty.data` frames no shipped client had to acknowledge. An attached holder is never displaced.
 */
async function claimOwner(
  mux: SshChannelMultiplexer,
  options: LegacyRelayClientOptions
): Promise<LegacyRelayOwnerClaim | null> {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deadline = Date.now() + OWNER_RETRY_BUDGET_MS
  let delayMs = 25
  let resume = options.resume ?? null
  for (;;) {
    try {
      const grant = await mux.request(
        'pty.openClient',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientInstanceId: options.clientInstanceId,
          requestedRole: 'session-owner',
          ...(resume ? { resume } : {})
        },
        { timeoutMs: OPEN_CLIENT_TIMEOUT_MS }
      )
      return parseOwnerGrant(grant, options.serverBuildId)
    } catch (error) {
      const code = errorCode(error)
      if (code === METHOD_NOT_FOUND) {
        return null
      }
      if (code === OWNER_HELD_ATTACHED) {
        throw new LegacyRelayOwnerHeldError()
      }
      const transient =
        code === OWNER_RECOVERY_PENDING ||
        code === OWNER_RECOVERY_SUPERSEDED ||
        code === OWNER_HELD_DISCONNECTED ||
        code === OWNER_HELD_SELF
      if (!transient && resume) {
        // A stale claim the relay no longer recognises: ask for a fresh one.
        resume = null
        continue
      }
      if (!transient || Date.now() >= deadline || mux.isDisposed()) {
        throw error
      }
      await sleep(delayMs)
      delayMs = Math.min(delayMs * 2, 1_000)
    }
  }
}
