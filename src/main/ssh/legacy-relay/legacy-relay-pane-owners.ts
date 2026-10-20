/**
 * Which relay process speaks for each relay id of one SSH target. The registry keeps one per
 * target across its bridges, so a reconnect remembers the owners.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 *
 * Relay ids repeat across relays (each numbers its own pty-1, pty-2…) and across restarts of one
 * relay at the same socket, so an owner is its endpoint plus the incarnation it listed. Once known,
 * no other process under that id is ever served for it.
 */
import type { Pane } from './legacy-relay-bridge-leases'
import type { LegacyRelayClient } from './legacy-relay-client'

type Owner = {
  endpoint: string
  incarnationId: string | undefined
  /** Its endpoint listed another process under the id, so that relay's silence proves nothing. */
  replaced?: true
}

export type LegacyRelayOwnerRow = { endpoint: string; incarnationId?: string | undefined }

export class LegacyRelayPaneOwners {
  /** `null`: two relays claimed the id before either was known to own it, so neither ever does. */
  private readonly owners = new Map<string, Owner | null>()
  /** Exit reports by relay endpoint, until the next listing reads or drops them. */
  private readonly unclaimedExits = new Map<string, number>()

  owner(relayPtyId: string): string | null | undefined {
    const owner = this.owners.get(relayPtyId)
    return owner === undefined ? undefined : (owner?.endpoint ?? null)
  }

  /** Whether `row` is the owner's own process; relays that report no incarnation can't be told apart. */
  isOwnerProcess(relayPtyId: string, row: LegacyRelayOwnerRow): boolean {
    const owner = this.owners.get(relayPtyId)
    return owner?.endpoint === row.endpoint && owner.incarnationId === row.incarnationId
  }

  /**
   * Whether a connection's report is about this pane's process: the one whose listing bound it.
   * Why not by endpoint: a relay reopened at the same socket may be a restart reusing the id.
   */
  speaksFor(pane: Pane | undefined, client: LegacyRelayClient): pane is Pane {
    const listed = pane?.listed
    return Boolean(
      listed && listed.client === client && this.isOwnerProcess(pane.relayPtyId, listed)
    )
  }

  claim(relayPtyId: string, row: LegacyRelayOwnerRow | null): void {
    this.owners.set(relayPtyId, row && { endpoint: row.endpoint, incarnationId: row.incarnationId })
  }

  /** The owner's endpoint now runs another process under the id; the owner's own fate is unknown. */
  markReplaced(relayPtyId: string): void {
    const owner = this.owners.get(relayPtyId)
    if (owner) {
      owner.replaced = true
    }
  }

  isReplaced(relayPtyId: string): boolean {
    return Boolean(this.owners.get(relayPtyId)?.replaced)
  }

  forget(relayPtyId: string): void {
    this.owners.delete(relayPtyId)
  }

  /**
   * Every exit report, kept until the next listing: one may race the listing that binds its pane.
   * Why by endpoint, not connection: a reopened socket's listing still reads an exit sent before it.
   */
  noteExit(relayPtyId: string, endpoint: string, code: number): void {
    this.unclaimedExits.set(`${endpoint}\n${relayPtyId}`, code)
  }

  exitBeforeListing(relayPtyId: string, endpoint: string): number | undefined {
    return this.unclaimedExits.get(`${endpoint}\n${relayPtyId}`)
  }

  /** After each listing: an exit it did not use came from a process it did not bind. */
  clearExits(): void {
    this.unclaimedExits.clear()
  }
}
