import type { RuntimeFileReadResult } from '../../../shared/runtime-file-contracts'
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
import { isMissingRuntimePathError } from './runtime-file-metadata-client'
import {
  isRenewableGrantError,
  renewTerminalArtifactGrant,
  type TerminalArtifactGrantTarget
} from './runtime-terminal-artifact-grant'

// Why: hosts cap a grant write at their mobile read budget; refuse before sending the bytes.
const TERMINAL_ARTIFACT_WRITE_MAX_BYTES = 512 * 1024

type GrantTarget = TerminalArtifactGrantTarget

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
    if (isRenewableGrantError(error)) {
      throw error
    }
    if (isMissingRuntimePathError(error)) {
      return null
    }
    // Why: binary or oversized host text can't be compared, so it counts as changed.
    if (
      error instanceof RuntimeRpcCallError &&
      (error.message === 'binary_file' || error.message === 'file_too_large')
    ) {
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
    /** The tab keeps the renewed grant so later reads and saves skip renewal. */
    onGrantRenewed?: (grantId: string) => void
  }
): Promise<FileWriteResult> {
  if (new TextEncoder().encode(args.content).byteLength > TERMINAL_ARTIFACT_WRITE_MAX_BYTES) {
    throw new Error('This file is too large to save to its host (512 KB limit).')
  }
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
    await callRuntimeRpc(
      args.target,
      'files.writeTerminalArtifact',
      {
        worktree: toRuntimeWorktreeSelector(args.worktreeId),
        grantId,
        absolutePath: args.absolutePath,
        content: args.content
      },
      // Why: runs after connection setup, so a discard during it still stops the write.
      { timeoutMs: 15_000, beforeSend: args.beforeSend }
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
  const renewed = await renewTerminalArtifactGrant(args)
  if (renewed?.readOnly) {
    throw new Error('This host opens the file read-only.')
  }
  if (renewed !== null) {
    args.onGrantRenewed?.(renewed.grantId)
  }
  const refused = await refusal(renewed?.grantId ?? null)
  if (refused) {
    return refused
  }
  if (renewed === null) {
    throw new Error(`File not found on its host: ${args.absolutePath}`)
  }
  return send(renewed.grantId)
}
