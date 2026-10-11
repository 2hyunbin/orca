import type { FileStat, IFilesystemProvider } from '../providers/types'
import type { RuntimeFilePreviewResult } from '../../shared/runtime-types'
import type { TerminalFileGrant } from './runtime-terminal-file-grants'
import {
  LOCAL_PREVIEWABLE_BINARY_MAX_BYTES,
  MOBILE_FILE_READ_MAX_BYTES,
  previewableBinaryByteLimit
} from './runtime-file-commands-mobile-file-list-limit'
import { assertTerminalFileGrantFresh } from './runtime-terminal-artifact-integrity'
import { requireFilesystemProviderForHost } from '../providers/execution-host-provider-dispatch'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'

export async function readRemoteTerminalArtifactPreview(
  provider: IFilesystemProvider,
  grant: TerminalFileGrant,
  maxContentBytes: number | undefined
): Promise<RuntimeFilePreviewResult> {
  const binaryMaxBytes =
    maxContentBytes === undefined
      ? LOCAL_PREVIEWABLE_BINARY_MAX_BYTES
      : previewableBinaryByteLimit(maxContentBytes)
  const preview = await readRemoteTerminalArtifact(provider, grant, binaryMaxBytes)
  if (
    !preview.isBinary &&
    Buffer.byteLength(preview.content, 'utf8') > MOBILE_FILE_READ_MAX_BYTES
  ) {
    throw new Error('file_too_large')
  }
  if (
    preview.isBinary &&
    maxContentBytes !== undefined &&
    Buffer.byteLength(preview.content, 'utf8') > maxContentBytes
  ) {
    throw new Error('file_too_large')
  }
  return preview
}

export async function readRemoteTerminalArtifactFile(
  provider: IFilesystemProvider,
  grant: TerminalFileGrant,
  maxBytes: number
): Promise<string> {
  const result = await readRemoteTerminalArtifact(provider, grant, maxBytes)
  if (result.isBinary) {
    throw new Error('binary_file')
  }
  return result.content
}

async function readRemoteTerminalArtifact(
  provider: IFilesystemProvider,
  grant: TerminalFileGrant,
  maxBytes: number
): Promise<RuntimeFilePreviewResult> {
  if (!provider.readTerminalArtifact) {
    throw new Error('terminal_file_grant_unavailable')
  }
  return provider.readTerminalArtifact(
    grant.absolutePath,
    terminalArtifactAccessOptions(grant, maxBytes)
  )
}

export function terminalArtifactAccessOptions(
  grant: TerminalFileGrant,
  maxBytes: number
): { expectedRealPath: string; expectedStatIdentity: string | null; maxBytes: number } {
  return {
    expectedRealPath: grant.absolutePath,
    expectedStatIdentity: grant.statIdentity,
    maxBytes
  }
}

export async function assertRemoteTerminalFileGrantFreshForRead(
  grant: TerminalFileGrant
): Promise<IFilesystemProvider> {
  const { provider } = await assertRemoteTerminalFileGrantFresh(grant)
  return provider
}

export async function assertRemoteTerminalFileGrantFresh(
  grant: TerminalFileGrant
): Promise<{ provider: IFilesystemProvider; fileStat: FileStat }> {
  const provider = await assertRemoteTerminalFileGrantPathStillCanonical(grant)
  const fileStat = await provider.stat(grant.absolutePath)
  assertTerminalFileGrantFresh(grant, fileStat)
  return { provider, fileStat }
}

async function assertRemoteTerminalFileGrantPathStillCanonical(
  grant: TerminalFileGrant
): Promise<IFilesystemProvider> {
  if (!grant.connectionId) {
    throw new Error('terminal_file_grant_mismatch')
  }
  const provider = requireFilesystemProviderForHost(toSshExecutionHostId(grant.connectionId))
  const canonicalPath =
    grant.provenance === 'native-chat'
      ? await provider.realpath(grant.absolutePath)
      : await resolveAllowedRemoteTerminalArtifactPath(grant.absolutePath, grant.connectionId)
  // Why: relay I/O follows symlinks, so re-canonicalize after the remote process can mutate the path.
  if (canonicalPath !== grant.absolutePath) {
    throw new Error('terminal_file_grant_stale')
  }
  return provider
}

export async function resolveAllowedRemoteTerminalArtifactPath(
  absolutePath: string,
  connectionId: string
): Promise<string | null> {
  const provider = requireFilesystemProviderForHost(toSshExecutionHostId(connectionId))
  const roots = ['/tmp', '/private/tmp']
  const providerTempDir = await provider.getTempDir?.().catch(() => null)
  if (providerTempDir) {
    roots.push(providerTempDir)
  }
  if (!roots.some((root) => isPathInsideOrEqual(root, absolutePath))) {
    return null
  }
  const [realArtifactPath, ...realRoots] = await Promise.all([
    provider.realpath(absolutePath),
    ...roots.map((root) => provider.realpath(root).catch(() => root))
  ])
  // Why: SSH I/O follows symlinks on the relay; grant the canonical target so a /tmp link can't escape the temp boundary.
  return realRoots.some((root) => isPathInsideOrEqual(root, realArtifactPath))
    ? realArtifactPath
    : null
}
