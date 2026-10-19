/**
 * One target's stops for bridged panes whose tab closed, sent with the old relay's own
 * `pty.shutdown`. COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 *
 * Held outside the bridge, so a reconnect's new bridge still sends them. A stop is pending until
 * the relay reports the exit or a listing proves the terminal gone; while the relay can't be asked
 * the answer is `unverifiable` and the stop goes out once it can. Loss of contact is never exit.
 *
 * A stop whose process can be named after a restart is persisted as the lease's `pendingKill`, the
 * relay-era record of the same intent, so closing a tab and quitting before reconnecting still
 * stops the shell. The relay connection is the other proof of identity, and it does not survive.
 */
import { parseAppSshPtyId, toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { SshPendingPtyKill } from '../../../shared/ssh-pending-pty-kill'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import type { LegacyRelayBridgeCloseResult } from '../../../shared/legacy-relay-bridge-contract'
import { isStoppingLease, listedAppPtyIds } from './legacy-relay-bridge-leases'
import { LegacyRelayRetry } from './legacy-relay-bridge-timers'
import type { LegacyRelayClient } from './legacy-relay-client'
import type { LegacyRelayBridgeHost } from './legacy-relay-bridge-registry'
import type { LegacyRelayTargetBridge } from './legacy-relay-target-bridge'

type StopTarget = Pick<
  LegacyRelayTargetBridge,
  'paneState' | 'liveRoute' | 'listedIncarnation' | 'refresh'
>

/**
 * Who the closed tab's process was: the relay's incarnation when it reports one, else the live
 * connection that showed it. Neither, for a stop recorded while the relay couldn't be asked.
 */
type PendingStop = { incarnationId?: string; client?: LegacyRelayClient }

export class LegacyRelayPaneStops {
  private readonly closing = new Map<string, PendingStop>()
  private bridge: StopTarget | null = null
  private readonly relist = new LegacyRelayRetry(() => void this.bridge?.refresh())

  constructor(
    private readonly targetId: string,
    private readonly host: () => Pick<LegacyRelayBridgeHost, 'leases' | 'recordStop'> | null
  ) {}

  private leases(): SshRemotePtyLease[] {
    return this.host()?.leases(this.targetId) ?? []
  }

  /** Writes the lease's stop record; null clears it. */
  private persist(relayPtyId: string, pendingKill: SshPendingPtyKill | null): void {
    this.host()?.recordStop(this.targetId, relayPtyId, pendingKill)
  }

  /** `bridge` is null while the target is disconnected; its next listing sends the stop. */
  async stop(ptyId: string, bridge: StopTarget | null): Promise<LegacyRelayBridgeCloseResult> {
    const state = bridge?.paneState(ptyId)
    if (!state && !listedAppPtyIds(this.targetId, this.leases()).has(ptyId)) {
      return { status: 'exited' }
    }
    // A repeated close while the relay can't be asked keeps the identity the first one saw.
    const earlier = this.pending(ptyId)
    const incarnationId = bridge?.listedIncarnation(ptyId) ?? earlier?.incarnationId
    const client = bridge?.liveRoute(ptyId)?.client ?? earlier?.client
    this.closing.set(ptyId, {
      ...(incarnationId ? { incarnationId } : {}),
      ...(client ? { client } : {})
    })
    this.record(ptyId, incarnationId)
    if (!bridge || state !== 'live') {
      return { status: 'unverifiable' }
    }
    const sent = await this.send(ptyId, bridge)
    // Only the relay's exit report or a listing without the terminal proves the stop.
    void bridge.refresh()
    return sent ? { status: 'requested' } : { status: 'unverifiable' }
  }

  /** Runs after each listing: re-sends pending stops, re-listing on backoff while one still runs. */
  flush(bridge: StopTarget): void {
    this.bridge = bridge
    const leases = this.leases()
    const listed = listedAppPtyIds(this.targetId, leases)
    const owed = new Set([...this.closing.keys(), ...this.persisted(leases).keys()])
    let pending = false
    for (const ptyId of owed) {
      const state = bridge.paneState(ptyId)
      if (!state) {
        if (!listed.has(ptyId)) {
          this.closing.delete(ptyId)
        }
        continue
      }
      pending = true
      if (state === 'live') {
        void this.send(ptyId, bridge)
      }
    }
    if (pending) {
      this.relist.schedule()
    } else {
      this.relist.reset()
    }
  }

  dispose(): void {
    this.relist.cancel()
    this.closing.clear()
  }

  /** Whether its tab closed and the stop is still owed, recorded now or by a previous run. */
  owes(ptyId: string): boolean {
    return this.pending(ptyId) !== undefined
  }

  get size(): number {
    return this.closing.size
  }

  /** This session's record of the stop, else the one a previous run persisted. */
  private pending(ptyId: string): PendingStop | undefined {
    return this.closing.get(ptyId) ?? this.persisted(this.leases()).get(ptyId)
  }

  private persisted(leases: SshRemotePtyLease[]): Map<string, PendingStop> {
    const stops = new Map<string, PendingStop>()
    for (const lease of leases) {
      if (isStoppingLease(lease)) {
        const incarnationId = lease.pendingKill?.incarnationId
        stops.set(toAppSshPtyId(this.targetId, lease.ptyId), incarnationId ? { incarnationId } : {})
      }
    }
    return stops
  }

  /** Persists only a stop a later run can fence: a `pty2:` id or a listed incarnation. */
  private record(ptyId: string, incarnationId: string | undefined): void {
    const relayPtyId = parseAppSshPtyId(ptyId)?.relayPtyId
    if (relayPtyId && (incarnationId || relayPtyId.startsWith('pty2:'))) {
      this.persist(relayPtyId, {
        requestedAt: Date.now(),
        ...(incarnationId ? { incarnationId } : {}),
        attempts: 0
      })
    }
  }

  /** The stop can no longer reach the tab's process: that id now names another one. */
  private forget(ptyId: string): void {
    this.closing.delete(ptyId)
    const relayPtyId = parseAppSshPtyId(ptyId)?.relayPtyId
    if (relayPtyId && this.persisted(this.leases()).has(ptyId)) {
      this.persist(relayPtyId, null)
    }
  }

  /** The old relay's own stop, fenced to the process the tab ran; false when it can't be asked. */
  private async send(ptyId: string, bridge: StopTarget): Promise<boolean> {
    const route = bridge.liveRoute(ptyId)
    const pending = this.pending(ptyId)
    if (!route || !pending) {
      return false
    }
    const listed = bridge.listedIncarnation(ptyId)
    // Only positive identity sends a stop: a legacy `pty-N` id restarts at 1 with its relay, and an
    // older relay ignores the incarnation fence. A `pty2:` id carries its relay's start epoch.
    const sameProcess = route.client === pending.client || route.relayPtyId.startsWith('pty2:')
    const proven = pending.incarnationId
      ? listed === pending.incarnationId || (listed === undefined && sameProcess)
      : sameProcess
    if (!proven) {
      this.forget(ptyId)
      return false
    }
    try {
      await route.client.shutdown(route.relayPtyId, pending.incarnationId)
      return true
    } catch (error) {
      // The relay's own fence refused it: that id now runs another process.
      if (/incarnation mismatch/i.test(error instanceof Error ? error.message : String(error))) {
        this.forget(ptyId)
      }
      return false
    }
  }
}
