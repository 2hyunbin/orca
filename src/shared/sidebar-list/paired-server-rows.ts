import { z } from 'zod'
import type { ExecutionHostId } from '../execution-host'
import { composeWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { openEnum } from '../zod-salvage'
import { SMART_TIERS } from './sort-stamps'
import { WorkspaceRowSchema } from './workspace-rows'

/** One paired-server workspace as the sidebar lists it, keyed by its host-qualified id. */
const PairedServerWorkspaceRowSchema = z
  .object({
    key: z.string(),
    worktreeId: z.string(),
    repoId: z.string(),
    kind: z.enum(['git', 'folder']),
    path: z.string(),
    branch: z.string(),
    displayName: z.string(),
    isArchived: z.boolean(),
    isPinned: z.boolean()
  })
  .extend(
    // What the list sorts, groups and filters by, as the server stamped it; older desktops omit them.
    WorkspaceRowSchema.pick({
      isMainWorktree: true,
      workspaceStatus: true,
      sortOrder: true,
      manualOrder: true,
      createdAt: true,
      creatorProvenance: true,
      defaultBranch: true,
      automationCreated: true,
      cliCreated: true,
      detachedHead: true,
      recentAt: true,
      smartTier: true,
      smartAt: true
    }).partial().shape
  )

/** See PairedServerHost; health and compatibility stay open strings, as a reader only compares them. */
const PairedServerHostFactsSchema = z.object({
  label: z.string(),
  health: z.string(),
  compatibility: z.string().nullable(),
  pairedDeviceId: z.string().nullable()
})

/** Every configured server main lists rows for. Unverifiable: its last rows, not confirmed current. */
export const PairedServerRowsSnapshotSchema = z.object({
  revision: z.number(),
  servers: z.array(
    z.object({
      hostId: z.string(),
      freshness: z.enum(['live', 'unverifiable']),
      /** Null while the desktop does not show the server (a managed one folded into its SSH host). */
      host: PairedServerHostFactsSchema.nullable(),
      rows: z.array(PairedServerWorkspaceRowSchema)
    })
  )
})

export type PairedServerHostFacts = z.infer<typeof PairedServerHostFactsSchema>

export type PairedServerWorkspaceRow = z.infer<typeof PairedServerWorkspaceRowSchema>
export type PairedServerRowsSnapshot = z.infer<typeof PairedServerRowsSnapshotSchema>

// Older servers omit `workspaceKind` and may send arms this build has not heard of.
const ServerWorktreePsRowSchema = z.object({
  worktreeId: z.string().min(1),
  repoId: z.string(),
  workspaceKind: openEnum(['git', 'folder-workspace'], 'git').optional(),
  path: z.string().catch(''),
  branch: z.string().catch(''),
  displayName: z.string().catch(''),
  isArchived: z.boolean().catch(false),
  isPinned: z.boolean().catch(false),
  isMainWorktree: z.boolean().catch(false),
  workspaceStatus: z.string().optional().catch(undefined),
  sortOrder: z.number().optional().catch(undefined),
  manualOrder: z.number().optional().catch(undefined),
  createdAt: z.number().optional().catch(undefined),
  creatorProvenance: WorkspaceRowSchema.shape.creatorProvenance.catch(undefined),
  defaultBranch: z.boolean().optional().catch(undefined),
  automationCreated: z.literal(true).optional().catch(undefined),
  cliCreated: z.literal(true).optional().catch(undefined),
  detachedHead: z.literal(true).optional().catch(undefined),
  lastActivityAt: z.number().optional().catch(undefined),
  smartTier: z.enum(SMART_TIERS).optional().catch(undefined),
  smartAt: z.number().optional().catch(undefined)
})

/** A server's own `worktree.ps` row, with defaults for what older servers omit; null without an id. */
export function normalizePairedServerRow(
  hostId: ExecutionHostId,
  row: unknown
): PairedServerWorkspaceRow | null {
  const parsed = ServerWorktreePsRowSchema.safeParse(row)
  if (!parsed.success) {
    return null
  }
  const { workspaceKind, lastActivityAt, ...fields } = parsed.data
  return {
    key: composeWorktreeHostIdentity(hostId, fields.worktreeId),
    kind: workspaceKind === 'folder-workspace' ? 'folder' : 'git',
    ...fields,
    recentAt: lastActivityAt
  }
}
