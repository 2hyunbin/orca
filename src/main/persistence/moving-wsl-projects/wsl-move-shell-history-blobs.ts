/**
 * The moved worktrees' zsh/bash history files (under the desktop's per-distro WSL history root) as
 * `shell-history` migration blobs, keyed by the worktree id the destination host will use.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertOrcadMigrationBlobSet,
  orcadMigrationBlobIdentity,
  sameOrcadMigrationBlob,
  type OrcadMigrationBlobDescriptor
} from '../../../shared/orcad-migration-blob-transfer'
import type { OrcadMigrationBlobSource } from '../../ssh/orcad-migration-blob-coordinator'
import { getHistoryRootWsl } from '../../terminal-history-paths'
import { hashWorktreeId } from '../../terminal-history-id'
import {
  MAX_ORCAD_MIGRATION_SHELL_HISTORY_BYTES,
  ORCAD_MIGRATION_SHELL_HISTORY_SHELLS,
  encodeOrcadMigrationShellHistoryHeader,
  orcadMigrationShellHistoryKey,
  shellHistoryFileName
} from '../migrating-orcad-catalog/orcad-migration-shell-history-format'

export type WslMoveShellHistoryWorktree = {
  /** The id the desktop keyed history by: the UNC worktree id. */
  sourceWorktreeId: string
  /** The same worktree's id on the host, after the mover's path rewrite. */
  destinationWorktreeId: string
}

export type WslMoveShellHistoryRequest = {
  distro: string
  worktrees: readonly WslMoveShellHistoryWorktree[]
  /** Defaults to the desktop's history root for `distro`. */
  historyRoot?: string
}

export type WslMoveShellHistoryBlobs = {
  descriptors: OrcadMigrationBlobDescriptor[]
  source: OrcadMigrationBlobSource
}

type ShellHistoryFile = {
  descriptor: OrcadMigrationBlobDescriptor
  header: Buffer
  path: string
  fileBytes: number
}

/**
 * Missing and empty files send nothing. A file over the per-blob cap blocks the move: history is
 * never truncated. The source refuses a read once a file's size moved, so a shell that wrote after
 * quiesce fails the transfer instead of sending bytes the digest does not cover.
 */
export async function buildWslMoveShellHistoryBlobs(
  request: WslMoveShellHistoryRequest
): Promise<WslMoveShellHistoryBlobs> {
  const root = request.historyRoot ?? getHistoryRootWsl(request.distro)
  const files: ShellHistoryFile[] = []
  for (const worktree of request.worktrees) {
    const directory = join(root, hashWorktreeId(worktree.sourceWorktreeId))
    let zshSent = false
    for (const shell of ORCAD_MIGRATION_SHELL_HISTORY_SHELLS) {
      const path = join(directory, shellHistoryFileName(shell))
      const fileBytes = await regularFileSize(path)
      if (fileBytes === 0) {
        continue
      }
      const key = orcadMigrationShellHistoryKey(worktree.destinationWorktreeId, shell)
      // zsh is listed first, so a bash file without a zsh sibling is known here.
      const header = encodeOrcadMigrationShellHistoryHeader(worktree.destinationWorktreeId, {
        loginShell: shell === 'bash' && !zshSent
      })
      zshSent ||= shell === 'zsh'
      const byteLength = header.length + fileBytes
      if (byteLength > MAX_ORCAD_MIGRATION_SHELL_HISTORY_BYTES) {
        throw new Error(`orcad_migration_shell_history_too_large:${key}`)
      }
      files.push({
        descriptor: {
          blobKind: 'shell-history',
          key,
          sha256: await digestFile(header, path, fileBytes),
          byteLength
        },
        header,
        path,
        fileBytes
      })
    }
  }
  const descriptors = files.map((file) => file.descriptor)
  assertOrcadMigrationBlobSet(descriptors)
  const byIdentity = new Map(
    files.map((file) => [orcadMigrationBlobIdentity(file.descriptor), file])
  )
  return {
    descriptors,
    source: {
      readChunk: async (requested, offset, maxBytes) => {
        const file = byIdentity.get(orcadMigrationBlobIdentity(requested))
        if (!file || !sameOrcadMigrationBlob(requested, file.descriptor)) {
          throw new Error(`orcad_migration_source_blob_changed:${requested.blobKind}`)
        }
        return readShellHistoryChunk(file, offset, maxBytes)
      }
    }
  }
}

// 0 for a missing file or anything that is not a regular file.
async function regularFileSize(path: string): Promise<number> {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

async function digestFile(header: Buffer, path: string, fileBytes: number): Promise<string> {
  const hash = createHash('sha256').update(header)
  let read = 0
  // `end` pins the digest to the size the descriptor declares even if the file grows meanwhile.
  for await (const chunk of createReadStream(path, {
    start: 0,
    end: fileBytes - 1
  })) {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error('orcad_migration_shell_history_read_failed')
    }
    hash.update(chunk)
    read += chunk.length
  }
  if (read !== fileBytes) {
    throw new Error('orcad_migration_source_blob_changed:shell-history')
  }
  return hash.digest('hex')
}

async function readShellHistoryChunk(
  file: ShellHistoryFile,
  offset: number,
  maxBytes: number
): Promise<Buffer> {
  const end = Math.min(offset + maxBytes, file.descriptor.byteLength)
  const parts: Buffer[] = []
  if (offset < file.header.length) {
    parts.push(file.header.subarray(offset, Math.min(end, file.header.length)))
  }
  const fileStart = Math.max(offset - file.header.length, 0)
  const fileEnd = end - file.header.length
  if (fileEnd > fileStart) {
    const handle = await open(file.path, 'r')
    try {
      if ((await handle.stat()).size !== file.fileBytes) {
        throw new Error('orcad_migration_source_blob_changed:shell-history')
      }
      const buffer = Buffer.alloc(fileEnd - fileStart)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, fileStart)
      if (bytesRead !== buffer.length) {
        throw new Error('orcad_migration_source_blob_changed:shell-history')
      }
      parts.push(buffer)
    } finally {
      await handle.close()
    }
  }
  return Buffer.concat(parts)
}
