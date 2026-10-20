import { z } from 'zod'
import { MAX_WORKTREE_SELECTOR_LENGTH } from './agent-session-params'

/** Sent when the window mounts its list; a new id resets main's Smart latch and retention. */
export const SidebarSessionBeginParams = z.object({ sessionId: z.string().min(1).max(128) })

/** Every workspace the window holds asleep, replacing what it sent before. */
export const SidebarSessionSleptWorkspacesParams = z.object({
  worktreeIds: z.array(z.string().min(1).max(MAX_WORKTREE_SELECTOR_LENGTH)).max(10_000)
})
