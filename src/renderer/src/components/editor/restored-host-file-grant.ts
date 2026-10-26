import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { renewTerminalArtifactGrant } from '@/runtime/runtime-terminal-artifact-grant'

export const REMOTE_EXTERNAL_FILE_UNAVAILABLE_MESSAGE =
  'External local files are not available for remote workspaces.'

/** Grants are never persisted, so a restored host file outside every workspace asks its host again. */
export async function grantRestoredHostFile(
  target: RuntimeClientTarget,
  worktreeId: string | null | undefined,
  filePath: string
): Promise<string> {
  const renewed =
    target.kind === 'environment' && worktreeId
      ? await renewTerminalArtifactGrant({ target, worktreeId, absolutePath: filePath })
      : null
  if (!renewed) {
    throw new Error(REMOTE_EXTERNAL_FILE_UNAVAILABLE_MESSAGE)
  }
  return renewed.grantId
}
