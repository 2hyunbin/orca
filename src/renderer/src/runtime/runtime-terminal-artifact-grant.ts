import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { RuntimeTerminalPathResolution } from '../../../shared/runtime-file-contracts'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

// Why: the host refuses a grant whose file changed, expired, or belongs to an earlier connection.
const RENEWABLE_GRANT_ERRORS = new Set([
  'terminal_file_grant_stale',
  'terminal_file_grant_expired',
  'terminal_file_grant_mismatch'
])

export type TerminalArtifactGrantTarget = {
  target: RuntimeClientTarget & { kind: 'environment' }
  worktreeId: string
  absolutePath: string
}

export function isRenewableGrantError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && RENEWABLE_GRANT_ERRORS.has(error.message)
}

export type RenewedTerminalArtifactGrant = { grantId: string; readOnly: boolean }

/** A fresh grant for the same host path, or null when the host no longer has the file. */
export async function renewTerminalArtifactGrant(
  args: TerminalArtifactGrantTarget
): Promise<RenewedTerminalArtifactGrant | null> {
  const resolved = await callRuntimeRpc<RuntimeTerminalPathResolution>(
    args.target,
    'files.resolveTerminalPath',
    {
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      pathText: args.absolutePath,
      crossWorkspace: true
    },
    { timeoutMs: 15_000 }
  )
  const openTarget = resolved.openTarget
  if (openTarget?.kind === 'absolute-file' && openTarget.absolutePath === args.absolutePath) {
    return { grantId: openTarget.grantId, readOnly: openTarget.readOnly === true }
  }
  if (!resolved.exists) {
    return null
  }
  // Why: never redirect a read or save elsewhere; the host must grant this exact path.
  throw new Error(`The host no longer grants ${args.absolutePath}`)
}
