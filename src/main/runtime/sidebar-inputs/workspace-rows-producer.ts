import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import {
  buildWorkspaceRows,
  type WorkspaceRowsSnapshot
} from '../../../shared/sidebar-list/workspace-rows'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import type { ResolvedWorktreeSnapshot } from '../runtime-resolved-worktree-cache'
import type { RuntimeStore } from '../runtime-store-contract'
import { runtimeVisibleFolderWorkspaces } from '../runtime-visible-catalog'
import type {
  ResolvedWorktreeRepoScans,
  ResolvedWorktreeScanJoin
} from '../workspaces/workspace-catalog'
import { WORKTREE_METADATA_DOMAINS } from '../../persistence/loading-store/worktree-identity-metadata'
import { ProducerRevision } from './producer-revision'
import { WorkspaceGitIdentity } from './workspace-git-identity'
import { CachedScan } from './cached-scan'

// The settings the visibility filter reads: the defaults, and the layouts that classify a checkout.
const VISIBILITY_SETTINGS = [
  'worktreeVisibilityDefaults',
  'workspaceDir',
  'nestWorkspaces',
  'workspaceDirHistory'
] as const

function visibilitySettingsKey(store: RuntimeStore): string {
  const settings = store.getSettings()
  return JSON.stringify(VISIBILITY_SETTINGS.map((key) => settings[key] ?? null))
}

export type WorkspaceRowsSources = {
  store: RuntimeStore | null
  /** Every git repo's scan (cache-aware); the only slow part, never awaited by a publish. */
  scan: () => Promise<ResolvedWorktreeRepoScans>
  /** The fleet listing from cached scans and the store's metadata as it is now. */
  join: (scans: ResolvedWorktreeRepoScans) => ResolvedWorktreeScanJoin
  /** worktree.ps's visibility filters over a listing. */
  visible: (snapshot: ResolvedWorktreeSnapshot) => ResolvedWorktreeSnapshot
  onClientEvent: (
    listener: (event: RuntimeClientEvent) => void,
    options: { consumesTerminalSideEffects: false }
  ) => () => void
}

type Joined = {
  revision: number
  all: ResolvedWorktree[]
  rows: WorkspaceRowsSnapshot['rows']
  authoritativeIds: ResolvedWorktreeScanJoin['authoritativeIds']
}

/**
 * This host's workspace rows: cached per-repo scans joined with the store's metadata at read, so a
 * read is synchronous and a metadata write publishes without waiting on git; scans refresh apart.
 * The revision moves on catalog changes, applied scans and saves that may touch metadata; session
 * saves never move it.
 */
export class WorkspaceRowsProducer {
  readonly revision = new ProducerRevision()
  readonly gitIdentity = new WorkspaceGitIdentity()
  // What the last join's visibility filter read; null until a join or settings save.
  private visibilityKey: string | null = null
  private joined: Joined | null = null
  private readonly scans: CachedScan<ResolvedWorktreeRepoScans>

  constructor(private readonly sources: WorkspaceRowsSources) {
    this.scans = new CachedScan({
      label: 'workspace-rows',
      scan: () => sources.scan(),
      demand: () => this.revision.hasListeners(),
      applied: () => this.applied()
    })
    sources.onClientEvent(
      (event) => {
        if (event.type === 'worktreesChanged' || event.type === 'reposChanged') {
          this.revision.bump()
          this.scans.request()
        }
      },
      { consumesTerminalSideEffects: false }
    )
    // A full save may be a folder workspace or lineage write.
    sources.store?.onStateWritten?.((domains) => {
      const metadata =
        domains === undefined ||
        WORKTREE_METADATA_DOMAINS.some((domain) => domains.includes(domain))
      if (metadata || (domains.includes('settings') && this.visibilitySettingsChanged())) {
        // Urgent: the join is synchronous, so the write publishes now; git follows in a later one.
        this.revision.bump({ urgent: true })
        this.scans.request()
      }
    })
  }

  // Every settings save reports above, whichever path wrote it and whether or not it notified.
  private visibilitySettingsChanged(): boolean {
    const previous = this.visibilityKey
    this.visibilityKey = this.sources.store ? visibilitySettingsKey(this.sources.store) : null
    return previous !== null && previous !== this.visibilityKey
  }

  /** Settles once a scan this producer can serve from has applied. Never rejects. */
  ready(): Promise<void> {
    return this.scans.ready()
  }

  /** Settles once every scan requested so far has applied; for one-shot RPC readers. */
  settled(): Promise<void> {
    return this.scans.settled()
  }

  /** The rows from the cached scan; null before the first scan applies. */
  snapshot(): WorkspaceRowsSnapshot | null {
    const joined = this.join()
    return joined ? { revision: joined.revision, rows: joined.rows } : null
  }

  /** Every resolved workspace (before visibility) from the cached scan; null before the first. */
  resolvedWorktrees(): readonly ResolvedWorktree[] | null {
    return this.join()?.all ?? null
  }

  private join(): Joined | null {
    const { store } = this.sources
    const scans = this.scans.current
    if (!scans) {
      return null
    }
    const revision = this.revision.value
    if (this.joined?.revision === revision) {
      return this.joined
    }
    if (!store) {
      return { revision, all: [], rows: {}, authoritativeIds: new Set() }
    }
    this.visibilityKey = visibilitySettingsKey(store)
    const listing = this.sources.join(scans)
    if (listing.unscannedRepoCount > 0) {
      this.scans.request()
    }
    const all = listing.worktrees.map((worktree) => {
      const displayName = this.gitIdentity.title(worktree)
      return displayName === worktree.displayName ? worktree : { ...worktree, displayName }
    })
    const { worktrees, platformByRepoId } = this.sources.visible({ ...listing, worktrees: all })
    const rows = buildWorkspaceRows({
      worktrees,
      folderWorkspaces: runtimeVisibleFolderWorkspaces(store),
      repos: store.getRepos(),
      lineageById: store.getAllWorktreeLineage?.() ?? {}
    })
    for (const row of rows.values()) {
      const terminalPlatform = row.kind === 'git' ? platformByRepoId.get(row.repoId) : undefined
      if (terminalPlatform) {
        row.terminalPlatform = terminalPlatform
      }
    }
    this.joined = {
      revision,
      all,
      rows: Object.fromEntries(rows),
      authoritativeIds: listing.authoritativeIds
    }
    return this.joined
  }

  private applied(): void {
    this.joined = null
    const listing = this.join()
    const { store } = this.sources
    if (listing && store) {
      const clears = this.gitIdentity.observeScan(
        listing.all.filter((worktree) =>
          listing.authoritativeIds.has(composeWorktreeHostIdentity(worktree.hostId, worktree.id))
        )
      )
      for (const { target, updates } of clears) {
        store.setWorktreeMeta(target, updates)
      }
    }
    this.revision.bump()
  }
}
