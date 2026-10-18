import {
  getSshTargetIdForExecutionHost,
  parseExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import type { FolderWorkspace } from '../folder-workspace-types'
import { projectGroupIdFromRepoId } from '../folder-workspace-worktree'
import { parseWorkspaceKey } from '../workspace-scope'
import { getExecutionHostIdFromWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import type { WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import type { PairedServerWorkspaceRow } from './paired-server-rows'
import type { WorkspaceRow } from './workspace-rows'

/** What the filters read off a row that the host decided, not the reader (workspace-kinds.ts). */
export type SidebarFeedRowFacts = Partial<
  Pick<
    WorkspaceRow,
    'defaultBranch' | 'automationCreated' | 'cliCreated' | 'detachedHead' | 'creatorProvenance'
  >
>

/** One feed workspace as the shared builder reads it, keyed by host-qualified id. */
export type SidebarFeedWorkspace = {
  identity: string
  worktree: Worktree
  facts: SidebarFeedRowFacts
  /** Set on a folder row: the builder lists folder workspaces apart from worktrees. */
  folderWorkspace: FolderWorkspace | null
}

function baseWorktree(fields: {
  id: string
  hostId: ExecutionHostId | undefined
  repoId: string
  path: string
  branch: string
  displayName: string
  isMainWorktree: boolean
  isPinned: boolean
  isArchived: boolean
}): Worktree {
  const host = parseExecutionHostId(fields.hostId)
  return {
    ...fields,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isUnread: false,
    sortOrder: 0,
    lastActivityAt: 0,
    head: '',
    isBare: false,
    ...(host?.kind === 'runtime' ? { runtimeOwnerEnvironmentId: host.environmentId } : {})
  }
}

function folderWorkspaceOf(row: WorkspaceRow, worktree: Worktree): FolderWorkspace | null {
  const id = parseWorkspaceKey(row.id)
  const projectGroupId = projectGroupIdFromRepoId(row.repoId)
  if (id?.type !== 'folder' || !projectGroupId) {
    return null
  }
  return {
    id: id.folderWorkspaceId,
    projectGroupId,
    name: worktree.displayName,
    folderPath: worktree.path,
    executionHostId: parseExecutionHostId(row.hostId)?.id ?? null,
    connectionId: getSshTargetIdForExecutionHost(row.hostId),
    ...(worktree.creatorProvenance ? { creatorProvenance: worktree.creatorProvenance } : {}),
    linkedTask: null,
    linkedItems: row.linkedItems,
    comment: worktree.comment,
    isArchived: worktree.isArchived,
    isUnread: worktree.isUnread,
    isPinned: worktree.isPinned,
    sortOrder: worktree.sortOrder,
    ...(worktree.manualOrder !== undefined ? { manualOrder: worktree.manualOrder } : {}),
    workspaceStatus: worktree.workspaceStatus,
    lastActivityAt: worktree.lastActivityAt,
    ...(worktree.smartTier !== undefined
      ? { smartTier: worktree.smartTier, smartAt: worktree.smartAt }
      : {}),
    createdAt: worktree.createdAt ?? 0,
    updatedAt: 0
  }
}

/** A row this host lists in its own catalog (workspace-rows.ts), back in the builder's shape. */
export function readFeedWorkspaceRow(
  identity: string,
  row: WorkspaceRow
): SidebarFeedWorkspace | null {
  if (!parseExecutionHostId(row.hostId)) {
    return null
  }
  // The identity's host, not the owner: a row whose metadata names no host keeps its `|id` key.
  const hostId = getExecutionHostIdFromWorktreeHostIdentity(identity)
  const worktree: Worktree = {
    ...baseWorktree({ ...row, hostId }),
    ...(row.instanceId !== undefined ? { instanceId: row.instanceId } : {}),
    comment: row.comment,
    linkedIssue: row.linkedIssue,
    linkedPR: row.linkedPR,
    linkedLinearIssue: row.linkedLinearIssue,
    linkedGitLabMR: row.linkedGitLabMR,
    linkedGitLabIssue: row.linkedGitLabIssue,
    linkedItems: row.linkedItems,
    isUnread: row.isUnread,
    workspaceStatus: row.workspaceStatus,
    sortOrder: row.sortOrder ?? 0,
    ...(row.manualOrder !== undefined ? { manualOrder: row.manualOrder } : {}),
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
    ...(row.creatorProvenance ? { creatorProvenance: row.creatorProvenance } : {}),
    lastActivityAt: row.recentAt ?? 0,
    ...(row.smartTier !== undefined ? { smartTier: row.smartTier, smartAt: row.smartAt } : {})
  }
  const { defaultBranch, automationCreated, cliCreated, detachedHead, creatorProvenance } = row
  return {
    identity,
    worktree,
    facts: { defaultBranch, automationCreated, cliCreated, detachedHead, creatorProvenance },
    folderWorkspace: row.kind === 'folder' ? folderWorkspaceOf(row, worktree) : null
  }
}

/** A paired server's row, as the server's own list reports it; older desktops send fewer fields. */
export function readFeedPairedServerRow(
  row: PairedServerWorkspaceRow
): SidebarFeedWorkspace | null {
  const hostId = getExecutionHostIdFromWorktreeHostIdentity(row.key)
  if (!hostId || parseExecutionHostId(hostId)?.kind !== 'runtime') {
    return null
  }
  const worktree: Worktree = {
    ...baseWorktree({
      ...row,
      id: row.worktreeId,
      hostId,
      isMainWorktree: row.isMainWorktree ?? false
    }),
    workspaceStatus: row.workspaceStatus,
    sortOrder: row.sortOrder ?? 0,
    ...(row.manualOrder !== undefined ? { manualOrder: row.manualOrder } : {}),
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
    ...(row.creatorProvenance ? { creatorProvenance: row.creatorProvenance } : {}),
    lastActivityAt: row.recentAt ?? 0,
    ...(row.smartTier !== undefined ? { smartTier: row.smartTier, smartAt: row.smartAt } : {})
  }
  const { defaultBranch, automationCreated, cliCreated, detachedHead, creatorProvenance } = row
  return {
    identity: row.key,
    worktree,
    facts: { defaultBranch, automationCreated, cliCreated, detachedHead, creatorProvenance },
    folderWorkspace: null
  }
}

/** The stored lineage edges on the rows, as the builder's lineage map (keyed by bare id, as the window's). */
export function readFeedLineage(rows: Iterable<WorkspaceRow>): Record<string, WorktreeLineage> {
  const lineageById: Record<string, WorktreeLineage> = {}
  for (const row of rows) {
    if (row.lineage && !(row.id in lineageById)) {
      lineageById[row.id] = {
        worktreeId: row.id,
        ...row.lineage,
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 0
      }
    }
  }
  return lineageById
}
