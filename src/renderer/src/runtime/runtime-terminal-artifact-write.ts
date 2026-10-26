import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type {
  RuntimeFileReadResult,
  RuntimeTerminalPathResolution
} from '../../../shared/runtime-file-contracts'
import {
  compareDiskWritePrecondition,
  FILE_WRITE_OK,
  FILE_WRITE_UNCHANGED,
  type FileWriteDiskPrecondition,
  type FileWriteResult
} from '../../../shared/file-write-disk-precondition'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

// Why: the host refuses a grant whose file changed, expired, or belongs to an earlier connection.
const RENEWABLE_GRANT_ERRORS = new Set([
  'terminal_file_grant_stale',
  'terminal_file_grant_expired',
  'terminal_file_grant_mismatch'
])

type GrantTarget = {
  target: RuntimeClientTarget & { kind: 'environment' }
  worktreeId: string
  absolutePath: string
}

function isRenewableGrantError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && RENEWABLE_GRANT_ERRORS.has(error.message)
}

/** A fresh grant for the same host path, or null when the host no longer has the file. */
async function renewGrant(args: GrantTarget): Promise<string | null> {
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
    if (openTarget.readOnly) {
      throw new Error('This host opens the file read-only.')
    }
    return openTarget.grantId
  }
  if (!resolved.exists) {
    return null
  }
  // Why: never redirect the save elsewhere; the host must grant this exact path.
  throw new Error(`The host no longer grants ${args.absolutePath}`)
}

/** The decoded text on the host, null when missing, undefined when not comparable text. */
async function readGrantedText(
  args: GrantTarget,
  grantId: string
): Promise<string | null | undefined> {
  try {
    const result = await callRuntimeRpc<RuntimeFileReadResult>(
      args.target,
      'files.readTerminalArtifact',
      {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        grantId,
        absolutePath: args.absolutePath
      },
      { timeoutMs: 15_000 }
    )
    return result.truncated ? undefined : result.content
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.message === 'binary_file') {
      return undefined
    }
    throw error
  }
}

/** Saves a host file outside every workspace through its grant; never touches this computer's files. */
export async function writeRuntimeTerminalArtifactFile(
  args: GrantTarget & {
    grantId: string
    content: string
    precondition?: FileWriteDiskPrecondition
    beforeSend?: () => void
  }
): Promise<FileWriteResult> {
  const refusal = async (grantId: string | null): Promise<FileWriteResult | null> => {
    if (!args.precondition) {
      return null
    }
    const current = grantId === null ? null : await readGrantedText(args, grantId)
    const comparison = compareDiskWritePrecondition(args.precondition, current, args.content)
    if (comparison === 'identical') {
      return FILE_WRITE_UNCHANGED
    }
    return comparison === null ? null : { ok: false, diskConflict: comparison }
  }
  const send = async (grantId: string): Promise<FileWriteResult> => {
    args.beforeSend?.()
    await callRuntimeRpc(
      args.target,
      'files.writeTerminalArtifact',
      {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        grantId,
        absolutePath: args.absolutePath,
        content: args.content
      },
      { timeoutMs: 15_000 }
    )
    return FILE_WRITE_OK
  }
  try {
    return (await refusal(args.grantId)) ?? (await send(args.grantId))
  } catch (error) {
    if (!isRenewableGrantError(error)) {
      throw error
    }
  }
  // Why: the tab's grant lapsed or its file changed; a fresh grant and the same disk check decide.
  const renewed = await renewGrant(args)
  const refused = await refusal(renewed)
  if (refused) {
    return refused
  }
  if (renewed === null) {
    throw new Error(`File not found on its host: ${args.absolutePath}`)
  }
  return send(renewed)
}
