import type { Worktree } from '../worktree/types'
import type { NoticeHostContext } from './host-labels'
import { buildImportedWorktreesCardRow, buildNewExternalWorktreesInboxRow } from './row-builders'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  Row
} from './row-types'

// Groupings other than by project have no project headers to anchor hints to; without these rows an
// unpinned project's hidden workspaces would have no suggestion at all.
export function appendStandaloneDiscoveryRows(args: {
  result: Row[]
  importedWorktreesByRepo: ReadonlyMap<string, ImportedWorktreesCardCandidate>
  newExternalWorktreesInboxByRepo: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
  pinnedSectionWorktrees: readonly Worktree[]
  renderedNaturalAnchorRepoIds: ReadonlySet<string>
  noticeHostContextLabelByRepoId?: ReadonlyMap<string, NoticeHostContext>
}): void {
  // Mirrors emitPinnedGroup: a pinned project without natural rows already shows its first suggestion there.
  const pinnedFallbackRepoIds = new Set(
    args.pinnedSectionWorktrees
      .map((worktree) => worktree.repoId)
      .filter((repoId) => !args.renderedNaturalAnchorRepoIds.has(repoId))
  )
  for (const [repoId, candidate] of args.importedWorktreesByRepo) {
    if (!pinnedFallbackRepoIds.has(repoId)) {
      args.result.push(
        buildImportedWorktreesCardRow(
          candidate,
          'standalone',
          args.noticeHostContextLabelByRepoId?.get(repoId)
        )
      )
    }
  }
  for (const [repoId, candidate] of args.newExternalWorktreesInboxByRepo) {
    args.result.push(
      buildNewExternalWorktreesInboxRow(
        candidate,
        args.noticeHostContextLabelByRepoId?.get(repoId),
        'standalone'
      )
    )
  }
}
