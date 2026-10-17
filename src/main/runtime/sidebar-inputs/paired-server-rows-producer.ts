import { z } from 'zod'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type { MobileRelayServerWorktreeRow } from '../../../shared/mobile-relay-hosts-contract'
import {
  normalizePairedServerRow,
  type PairedServerRowsSnapshot
} from '../../../shared/sidebar-list/paired-server-rows'
import type { MobileDesktopRelayHosts } from '../mobile-desktop-relay/mobile-desktop-relay-hosts'
import {
  describeRelayHosts,
  relayHostFence,
  type DescribedRelayHost
} from '../mobile-desktop-relay/mobile-relay-host-descriptions'

// Why the phone's own full-catalog limit: the server's default page is 200 and nothing pages on.
const SERVER_WORKTREE_LIMIT = 10_000
// Why well under the phone's 30s request timeout: a hung server must answer with its last rows.
export const SERVER_FETCH_TIMEOUT_MS = 5_000
// Owner-approved fallback for changes a server announces no event for (status-only, older servers).
export const FALLBACK_REFRESH_MS = 30_000

const WorktreePsReplySchema = z.object({ worktrees: z.array(z.looseObject({})) })

type ServerEntry = {
  environmentId: string
  fence: string
  identity: DescribedRelayHost['identity']
  inContact: boolean
  /** Null until a fetch under this pairing answered. */
  rows: MobileRelayServerWorktreeRow[] | null
  lastFetchAnswered: boolean
  closeWatch: (() => void) | null
  refreshing: Promise<void> | null
  refreshAgain: boolean
}

/**
 * The desktop's one live set of paired-server workspace rows. Fetched when a server comes into
 * contact, on each of its change events, when a reader asks, and every 30 s while the list is
 * showing. A server that loses contact keeps its last rows as unverifiable; only removing or
 * re-pairing it drops them, and a fetch that answers replaces them, deletions included.
 */
export class PairedServerRowsProducer {
  private readonly servers = new Map<string, ServerEntry>()
  private hosts: MobileDesktopRelayHosts | null = null
  private revision = 0

  constructor(private readonly options: { hasDemand: () => boolean }) {}

  attach(hosts: MobileDesktopRelayHosts): () => void {
    this.hosts = hosts
    const stopStatus = hosts.onStatusChanged(() => this.sync())
    const stopRetired = hosts.onEnvironmentRetired(() => this.sync())
    const fallback = setInterval(() => {
      if (this.options.hasDemand()) {
        for (const entry of this.servers.values()) {
          if (entry.inContact) {
            void this.refresh(entry.environmentId)
          }
        }
      }
    }, FALLBACK_REFRESH_MS)
    fallback.unref?.()
    this.sync()
    return () => {
      clearInterval(fallback)
      stopStatus()
      stopRetired()
      for (const entry of this.servers.values()) {
        entry.closeWatch?.()
      }
      this.servers.clear()
      this.hosts = null
      this.revision += 1
    }
  }

  /**
   * Re-reads the configured servers: drops removed or re-paired ones, watches those in contact
   * and fetches one that just came into contact. Returns the servers as described.
   */
  sync(): DescribedRelayHost[] {
    const hosts = this.hosts
    if (!hosts) {
      return []
    }
    const described = describeRelayHosts(hosts)
    const listed = new Map(described.map((host) => [host.environmentId, host]))
    for (const [environmentId, entry] of this.servers) {
      const host = listed.get(environmentId)
      if (!host || relayHostFence(host.identity) !== entry.fence) {
        entry.closeWatch?.()
        this.servers.delete(environmentId)
        this.revision += 1
      }
    }
    for (const host of described) {
      let entry = this.servers.get(host.environmentId)
      if (!entry) {
        entry = {
          environmentId: host.environmentId,
          fence: relayHostFence(host.identity),
          identity: host.identity,
          inContact: false,
          rows: null,
          lastFetchAnswered: false,
          closeWatch: null,
          refreshing: null,
          refreshAgain: false
        }
        this.servers.set(host.environmentId, entry)
        this.revision += 1
      }
      const inContact = host.health === 'available'
      if (inContact !== entry.inContact) {
        entry.inContact = inContact
        this.revision += 1
      }
      if (inContact && !entry.closeWatch) {
        this.watch(hosts, entry)
      } else if (!inContact && entry.closeWatch) {
        entry.closeWatch()
        entry.closeWatch = null
      }
    }
    return described
  }

  /** Fetches now, or joins the fetch in flight. */
  refresh(environmentId: string): Promise<void> {
    const entry = this.servers.get(environmentId)
    if (!entry || !this.hosts) {
      return Promise.resolve()
    }
    if (!entry.refreshing) {
      const refreshing = this.fetchUntilCurrent(this.hosts, entry).finally(() => {
        entry.refreshing = null
      })
      entry.refreshing = refreshing
    }
    return entry.refreshing
  }

  /** The server's raw rows as last fetched under this pairing; null when none were. */
  rows(environmentId: string, fence: string): readonly MobileRelayServerWorktreeRow[] | null {
    const entry = this.servers.get(environmentId)
    return entry && entry.fence === fence ? entry.rows : null
  }

  snapshot(): PairedServerRowsSnapshot {
    return {
      revision: this.revision,
      servers: [...this.servers.values()].map((entry) => {
        const hostId = toRuntimeExecutionHostId(entry.environmentId)
        return {
          hostId,
          freshness: entry.inContact && entry.lastFetchAnswered ? 'live' : 'unverifiable',
          rows: (entry.rows ?? []).flatMap((row) => normalizePairedServerRow(hostId, row) ?? [])
        }
      })
    }
  }

  private watch(hosts: MobileDesktopRelayHosts, entry: ServerEntry): void {
    const current = (): boolean => this.servers.get(entry.environmentId) === entry
    // Ready fires on every (re)connect, so contact and a missed-event replay both refetch.
    entry.closeWatch = hosts.watchChanges({ environmentId: entry.environmentId }, entry.identity, {
      onChange: () => {
        if (current()) {
          // A fetch already in flight may predate this change, so one more runs after it.
          entry.refreshAgain ||= entry.refreshing !== null
          void this.refresh(entry.environmentId)
        }
      },
      onClose: () => {
        if (current()) {
          entry.closeWatch = null
        }
      }
    })
  }

  private async fetchUntilCurrent(hosts: MobileDesktopRelayHosts, entry: ServerEntry) {
    do {
      entry.refreshAgain = false
      await this.fetch(hosts, entry)
    } while (entry.refreshAgain && this.servers.get(entry.environmentId) === entry)
  }

  private async fetch(hosts: MobileDesktopRelayHosts, entry: ServerEntry): Promise<void> {
    let response: Awaited<ReturnType<MobileDesktopRelayHosts['call']>> | null = null
    try {
      response = await hosts.call(
        { environmentId: entry.environmentId },
        'worktree.ps',
        { limit: SERVER_WORKTREE_LIMIT, supportsWorktreeVisibilitySourceDefaults: true },
        // Why the transport bound too: it ends the hung call, so the next request fetches afresh.
        { timeoutMs: SERVER_FETCH_TIMEOUT_MS, expected: entry.identity }
      )
    } catch {
      // An unreachable server keeps its last rows.
    }
    // Why: an answer that lands after a re-pair or removal belongs to the old pairing.
    if (this.servers.get(entry.environmentId) !== entry) {
      return
    }
    const reply = response?.ok ? WorktreePsReplySchema.safeParse(response.result) : null
    const answered = reply?.success === true
    if (reply?.success) {
      entry.rows = stampServerWorktreeRows(entry.environmentId, reply.data.worktrees)
    }
    // Every answer moves the revision: rows carry activity that changes without a catalog event.
    if (answered || entry.lastFetchAnswered) {
      entry.lastFetchAnswered = answered
      this.revision += 1
    }
  }
}

/**
 * A server's rows name hosts relative to that server (`local`, its own `ssh:` targets). Like the
 * desktop sidebar, the phone shows every one of them under the server, so all become its host id.
 */
function stampServerWorktreeRows<Row extends { hostId?: string }>(
  environmentId: string,
  rows: readonly Row[]
): (Row & { hostId: `runtime:${string}` })[] {
  const hostId = toRuntimeExecutionHostId(environmentId)
  return rows.map((row) => ({ ...row, hostId }))
}
