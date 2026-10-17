import { z } from 'zod'

const SortModeSchema = z.enum(['name', 'smart', 'recent', 'repo', 'manual'])

/** The frozen order main sampled at its last settle, as host-qualified ids. */
const SortSnapshotSchema = z.object({
  mode: SortModeSchema,
  /** Counts settles since the list session began. */
  epoch: z.number(),
  sampledAt: z.number(),
  rankedIds: z.array(z.string()),
  /** Smart has seen a live signal this session, so it ranks by attention, not saved order. */
  smartLatched: z.boolean()
})

/** Workspaces "Hide sleeping" keeps through a rebind gap; null while sleeping ones are shown. */
const RetentionSchema = z.object({
  retainedIds: z.array(z.string()),
  retentionDecidedAt: z.number()
})

export const SidebarTemporalSnapshotSchema = z.object({
  revision: z.number(),
  /** The list session the window last began; null until one begins (a headless host). */
  sessionId: z.string().nullable(),
  sortSnapshot: SortSnapshotSchema.nullable(),
  retention: RetentionSchema.nullable()
})

export type SidebarSortSnapshot = z.infer<typeof SortSnapshotSchema>
export type SidebarRetention = z.infer<typeof RetentionSchema>
export type SidebarTemporalSnapshot = z.infer<typeof SidebarTemporalSnapshotSchema>

/** Sent when the window mounts its list; a new id resets Smart's latch and retention. */
export const SidebarSessionBeginParams = z.object({ sessionId: z.string().min(1).max(128) })
