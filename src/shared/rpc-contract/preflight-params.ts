import { z } from 'zod'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../constants'
import { parseRoutableExecutionHostId } from '../execution-host'
import { OptionalExecutionHostId } from './worktree-params'

export const PreflightCheck = z.object({
  force: z.boolean().optional()
})

export const PreflightDetectRemoteAgents = z.object({
  connectionId: z.string().min(1)
})

export const PreflightDetectRemoteWindowsTerminalCapabilities = z.object({
  connectionId: z.string().min(1)
})

/** Why optional: a client that predates it sends nothing and keeps the host-default probe. */
export const PreflightAgentDetection = z
  .object({
    worktreeId: z.string().min(1).optional(),
    worktreeHostId: OptionalExecutionHostId
  })
  .superRefine((params, ctx) => {
    if (
      params.worktreeHostId !== undefined &&
      (!parseRoutableExecutionHostId(params.worktreeHostId) ||
        !params.worktreeId ||
        params.worktreeId === FLOATING_TERMINAL_WORKTREE_ID)
    ) {
      ctx.addIssue({ code: 'custom', message: 'A routable host requires an existing workspace.' })
    }
  })
