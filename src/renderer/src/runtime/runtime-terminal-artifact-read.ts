import type { RuntimeFilePreviewResult, RuntimeFileReadResult } from '../../../shared/runtime-types'
import type { RuntimeReadableFileContent } from './runtime-file-client-types'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  isRenewableGrantError,
  pinTerminalArtifactGrantTarget,
  renewTerminalArtifactGrant,
  type TerminalArtifactGrantTarget
} from './runtime-terminal-artifact-grant'

/** Reads a host file outside every workspace through its grant, renewing a lapsed or stale one. */
export async function readRuntimeTerminalArtifactContent(
  unpinned: TerminalArtifactGrantTarget & { grantId: string }
): Promise<RuntimeReadableFileContent> {
  const args = pinTerminalArtifactGrantTarget(unpinned)
  try {
    return await readThroughGrant(args)
  } catch (error) {
    if (!isRenewableGrantError(error)) {
      throw error
    }
  }
  // Why: a file changed on its host stales the tab's grant; Reload and Compare must still read it.
  const renewed = await renewTerminalArtifactGrant(args)
  if (!renewed) {
    throw new Error(`File not found on its host: ${args.absolutePath}`)
  }
  return readThroughGrant({ ...args, grantId: renewed.grantId })
}

async function readThroughGrant(
  args: TerminalArtifactGrantTarget & { grantId: string }
): Promise<RuntimeReadableFileContent> {
  const params = {
    worktree: toRuntimeWorktreeSelector(args.worktreeId),
    grantId: args.grantId,
    absolutePath: args.absolutePath
  }
  let result: RuntimeFileReadResult
  try {
    result = await callRuntimeRpc<RuntimeFileReadResult>(
      args.target,
      'files.readTerminalArtifact',
      params,
      {
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
      }
    )
  } catch (err) {
    // Why: the host refuses binary artifacts with this exact typed error; images use the preview.
    if (err instanceof RuntimeRpcCallError && err.message === 'binary_file') {
      return callRuntimeRpc<RuntimeFilePreviewResult>(
        args.target,
        'files.readTerminalArtifactPreview',
        params,
        {
          timeoutMs: 15_000,
          expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
        }
      )
    }
    throw err
  }
  if (result.truncated) {
    throw new Error(`Remote file is too large to open in the editor (${result.byteLength} bytes)`)
  }
  return { content: result.content, isBinary: false }
}
