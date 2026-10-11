import { constants } from 'node:fs/promises'
import {
  RuntimeTerminalFileGrants,
  type RuntimeTerminalFileGrantHost,
  type RuntimeFileStatLike,
  type TerminalFileGrant
} from './runtime-terminal-file-grants'
import type {
  RuntimeFilePreviewResult,
  RuntimeFileReadResult,
  RuntimeTerminalPathResolution
} from '../../shared/runtime-types'
import {
  canonicalPathForArtifactComparison,
  isTerminalArtifactHardLinked,
  truncateMobileFilePreview
} from './runtime-terminal-artifact-integrity'
import {
  resolveAllowedLocalTerminalArtifactPath,
  openLocalTerminalArtifactGrant,
  readLocalTerminalArtifactFileFromHandle,
  readLocalTerminalArtifactPreviewFromHandle
} from './runtime-file-commands-terminal-file-paths'
import { statLocalTerminalArtifact, statRemoteTerminalPath } from './runtime-terminal-artifact-stat'
import {
  resolveAllowedRemoteTerminalArtifactPath,
  assertRemoteTerminalFileGrantFreshForRead,
  readRemoteTerminalArtifactFile,
  readRemoteTerminalArtifactPreview
} from './runtime-terminal-artifact-remote'
import { requireReachableFilesystemRoute } from '../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../shared/execution-host'
import {
  MOBILE_FILE_READ_MAX_BYTES,
  assertPreviewWithinTransportBudget
} from './runtime-file-commands-mobile-file-list-limit'
import { isMobileBinaryPath } from './runtime-file-command-host'
import { writeTerminalArtifactFile } from './runtime-terminal-artifact-write'

export class RuntimeTerminalArtifacts {
  private readonly grants: RuntimeTerminalFileGrants

  constructor(host: RuntimeTerminalFileGrantHost) {
    this.grants = new RuntimeTerminalFileGrants(host)
  }

  async resolveAllowedTerminalArtifactPath(args: {
    absolutePath: string
    connectionId?: string
    worktreePath: string
  }): Promise<string | null> {
    if (args.connectionId) {
      return resolveAllowedRemoteTerminalArtifactPath(args.absolutePath, args.connectionId)
    }
    return resolveAllowedLocalTerminalArtifactPath(args.absolutePath, args.worktreePath)
  }

  async resolveNativeChatArtifactPath(
    absolutePath: string,
    connectionId?: string
  ): Promise<string> {
    const route = requireReachableFilesystemRoute(getConnectionExecutionHostId(connectionId))
    return route.kind === 'ssh'
      ? route.provider.realpath(absolutePath)
      : canonicalPathForArtifactComparison(absolutePath)
  }

  async resolveAbsoluteFileGrant(args: {
    worktreeId: string
    artifactPath: string
    rejectedAbsolutePath?: string
    connectionId?: string
    clientId?: string
    readOnly?: boolean
    provenance?: TerminalFileGrant['provenance']
  }): Promise<RuntimeTerminalPathResolution> {
    let contentDigest: string | null = null
    let stats: RuntimeFileStatLike & { isDirectory: () => boolean }
    if (args.connectionId) {
      stats = await statRemoteTerminalPath(args.artifactPath, args.connectionId)
    } else {
      const local = await statLocalTerminalArtifact(args.artifactPath)
      stats = local.stats
      contentDigest = local.contentDigest
    }
    const isDirectory = stats.isDirectory()
    if (!isDirectory && isTerminalArtifactHardLinked(stats)) {
      return {
        worktree: args.worktreeId,
        relativePath: null,
        absolutePath: args.rejectedAbsolutePath ?? args.artifactPath,
        exists: false,
        isDirectory: false
      }
    }
    const grant = isDirectory
      ? null
      : this.grants.createTerminalFileGrant({
          worktreeId: args.worktreeId,
          absolutePath: args.artifactPath,
          provider: args.connectionId ? 'ssh' : 'local',
          connectionId: args.connectionId,
          clientId: args.clientId,
          readOnly: args.readOnly === true,
          provenance: args.provenance ?? 'terminal-output',
          stats,
          contentDigest
        })
    return {
      worktree: args.worktreeId,
      relativePath: null,
      absolutePath: args.artifactPath,
      exists: true,
      isDirectory,
      openTarget: grant
        ? {
            kind: 'absolute-file',
            provider: grant.provider,
            absolutePath: args.artifactPath,
            grantId: grant.id,
            ...(grant.readOnly ? { readOnly: true } : {})
          }
        : undefined
    }
  }

  async readTerminalArtifactFile(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    clientId?: string
  ): Promise<RuntimeFileReadResult> {
    const { grant, target } = await this.grants.requireTerminalFileGrant(
      worktreeSelector,
      grantId,
      absolutePath,
      clientId
    )
    if (isMobileBinaryPath(grant.absolutePath)) {
      throw new Error('binary_file')
    }
    let content: string
    if (grant.connectionId) {
      const provider = await assertRemoteTerminalFileGrantFreshForRead(grant)
      content = await readRemoteTerminalArtifactFile(provider, grant, MOBILE_FILE_READ_MAX_BYTES)
    } else {
      const handle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
      try {
        content = await readLocalTerminalArtifactFileFromHandle(handle, grant)
      } finally {
        await handle.close()
      }
    }
    this.grants.refreshTerminalFileGrant(grant)
    const truncated = truncateMobileFilePreview(content)

    return {
      worktree: target.worktree.id,
      relativePath: grant.absolutePath,
      content: truncated.content,
      truncated: truncated.truncated,
      byteLength: truncated.byteLength
    }
  }

  async readTerminalArtifactPreview(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    clientId?: string,
    maxContentBytes?: number
  ): Promise<RuntimeFilePreviewResult> {
    const { grant } = await this.grants.requireTerminalFileGrant(
      worktreeSelector,
      grantId,
      absolutePath,
      clientId
    )
    if (grant.connectionId) {
      const provider = await assertRemoteTerminalFileGrantFreshForRead(grant)
      this.grants.refreshTerminalFileGrant(grant)
      return assertPreviewWithinTransportBudget(
        await readRemoteTerminalArtifactPreview(provider, grant, maxContentBytes),
        maxContentBytes
      )
    }
    const handle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
    try {
      const preview = await readLocalTerminalArtifactPreviewFromHandle(
        handle,
        grant,
        maxContentBytes
      )
      this.grants.refreshTerminalFileGrant(grant)
      return assertPreviewWithinTransportBudget(preview, maxContentBytes)
    } finally {
      await handle.close()
    }
  }

  revokeTerminalFileGrantsForClient(clientId: string): void {
    this.grants.revokeTerminalFileGrantsForClient(clientId)
  }

  writeTerminalArtifactFile(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    content: string,
    clientId?: string
  ): Promise<{ ok: true }> {
    return writeTerminalArtifactFile(
      this.grants,
      worktreeSelector,
      grantId,
      absolutePath,
      content,
      clientId
    )
  }
}
