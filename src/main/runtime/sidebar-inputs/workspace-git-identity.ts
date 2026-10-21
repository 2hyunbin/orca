import type { Worktree } from '../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  composeWorktreeHostIdentity,
  hostWorktreeTarget,
  type HostScopedWorktreeKey,
  type HostWorktreeTarget
} from '../../../shared/worktree/host-qualified-identity'
import {
  CLEARED_HOSTED_REVIEW_LINK_UPDATES,
  HOSTED_REVIEW_LINK_KEYS,
  canonicalHostedReviewBranchIdentity
} from '../../../shared/worktree/hosted-review-links'

type IdentityRow = Pick<
  Worktree,
  'id' | 'hostId' | 'instanceId' | 'branch' | 'displayName' | 'displayNameMode' | 'pushTarget'
> &
  Partial<Pick<Worktree, (typeof HOSTED_REVIEW_LINK_KEYS)[number]>>

type Observed = {
  instanceId: string | undefined
  branch: string
  displayName: string
  links: string
}

export type HostedReviewLinkClear = {
  target: HostWorktreeTarget
  updates: Pick<WorktreeMeta, (typeof HOSTED_REVIEW_LINK_KEYS)[number] | 'pushTarget'>
}

function keyOf(row: IdentityRow): HostScopedWorktreeKey {
  return composeWorktreeHostIdentity(row.hostId, row.id)
}

// Every branch-scoped field; an unchanged signature means nobody linked anything since the last scan.
function linksSignature(row: IdentityRow): string {
  return JSON.stringify([...HOSTED_REVIEW_LINK_KEYS.map((key) => row[key] ?? null), row.pushTarget])
}

function hasBranchScopedLinks(row: IdentityRow): boolean {
  return HOSTED_REVIEW_LINK_KEYS.some((key) => row[key] != null) || row.pushTarget !== undefined
}

/**
 * What a branch switch does to a workspace, decided where the scan sees it: an automatic title
 * follows the branch (and keeps its last name while the head is detached), and links scoped to the
 * old branch are cleared. Mirrors the window's worktree-git-identity-update.ts.
 */
export class WorkspaceGitIdentity {
  private readonly observed = new Map<HostScopedWorktreeKey, Observed>()
  private readonly detachedTitles = new Map<HostScopedWorktreeKey, string>()

  /** The title to publish for a row joined from the cached scan. */
  title(row: IdentityRow): string {
    const carried = this.detachedTitles.get(keyOf(row))
    return carried !== undefined && row.branch === '' && row.displayNameMode === 'automatic'
      ? carried
      : row.displayName
  }

  /**
   * Records the rows of authoritative scans only (a stalled scan's stored rows read as detached);
   * returns the link clears their branch switches call for.
   */
  observeScan(rows: readonly IdentityRow[]): HostedReviewLinkClear[] {
    const clears: HostedReviewLinkClear[] = []
    for (const row of rows) {
      const key = keyOf(row)
      const before = this.observed.get(key)
      const sameInstance = before !== undefined && before.instanceId === row.instanceId
      if (!sameInstance) {
        this.detachedTitles.delete(key)
      } else if (row.branch !== '') {
        this.detachedTitles.delete(key)
      } else if (before.branch !== '' && row.displayNameMode === 'automatic') {
        this.detachedTitles.set(key, before.displayName)
      }
      const switched =
        sameInstance &&
        canonicalHostedReviewBranchIdentity(before.branch) !==
          canonicalHostedReviewBranchIdentity(row.branch)
      // A link written since the last scan may belong to the new branch, so it is kept.
      const cleared = switched && hasBranchScopedLinks(row) && linksSignature(row) === before.links
      if (cleared && row.hostId !== undefined) {
        clears.push({
          target: hostWorktreeTarget({ id: row.id, hostId: row.hostId }),
          updates: CLEARED_HOSTED_REVIEW_LINK_UPDATES
        })
      }
      this.observed.set(key, {
        instanceId: row.instanceId,
        branch: row.branch,
        displayName: this.title(row),
        links: cleared
          ? linksSignature({ ...row, ...CLEARED_HOSTED_REVIEW_LINK_UPDATES })
          : linksSignature(row)
      })
    }
    return clears
  }
}
