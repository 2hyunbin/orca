import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import {
  buildWorkspaceRows,
  type WorkspaceRowsSnapshot
} from '../../../shared/sidebar-list/workspace-rows'
import type { ResolvedWorktreeSnapshot } from '../runtime-resolved-worktree-cache'
import type { RuntimeStore } from '../runtime-store-contract'
import { runtimeVisibleFolderWorkspaces } from '../runtime-visible-catalog'
import { WORKTREE_METADATA_DOMAINS } from '../../persistence/loading-store/worktree-identity-metadata'
import { ProducerRevision } from './producer-revision'

// Metadata saves name these; folder workspace and lineage writes are full saves (no domains).
const WORKTREE_META_DOMAINS: readonly string[] = WORKTREE_METADATA_DOMAINS

export type WorkspaceRowsSources = {
  store: RuntimeStore | null
  /** The listing worktree.ps reads, after its hidden-repo and visibility filters. */
  listVisibleWorktrees: () => Promise<ResolvedWorktreeSnapshot>
  invalidateListing: () => void
  onClientEvent: (
    listener: (event: RuntimeClientEvent) => void,
    options: { consumesTerminalSideEffects: false }
  ) => () => void
}

/**
 * This host's workspace rows, read on demand. The revision moves on catalog changes and metadata
 * writes only; terminal output writes neither, so it never makes one.
 */
export class WorkspaceRowsProducer {
  readonly revision = new ProducerRevision()

  constructor(private readonly sources: WorkspaceRowsSources) {
    sources.onClientEvent(
      (event) => {
        if (event.type === 'worktreesChanged' || event.type === 'reposChanged') {
          this.revision.bump()
        }
      },
      { consumesTerminalSideEffects: false }
    )
    // Session writes name their own domains, so terminal activity never reaches this.
    sources.store?.onStateWritten?.((domains) => {
      if (
        domains === undefined ||
        domains.some((domain) => WORKTREE_META_DOMAINS.includes(domain))
      ) {
        // The window applies its own metadata writes and announces none; the listing copied the old ones.
        sources.invalidateListing()
        this.revision.bump()
      }
    })
  }

  async snapshot(): Promise<WorkspaceRowsSnapshot> {
    const { store } = this.sources
    const revision = this.revision.value
    if (!store) {
      return { revision, rows: {} }
    }
    const { worktrees, platformByRepoId } = await this.sources.listVisibleWorktrees()
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
    return { revision, rows: Object.fromEntries(rows) }
  }
}
