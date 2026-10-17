import { z } from 'zod'

/**
 * One section's collapse, sent by `ui.setCollapsed`. `opId.seq` grows with each change a writer
 * makes; a writer is one client instance with its own counter. A retry resends the same opId.
 */
export const SetCollapsedParams = z.object({
  key: z.string().min(1).max(1024),
  collapsed: z.boolean(),
  opId: z.object({
    writer: z.string().min(1).max(128),
    seq: z.number().int().nonnegative()
  })
})

export type SetCollapsedRequest = z.infer<typeof SetCollapsedParams>

/** `applied: false` settles the op too: it already ran, or the same writer changed the key since. */
export type SetCollapsedResult = { collapsed: boolean; applied: boolean }
