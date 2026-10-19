import type { PreloadApi } from '../../../preload/api-types'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { SshConnectionState, SshMutationExpectation } from '../../../shared/ssh-types'
import type { Worktree } from '../../../shared/worktree/types'
import { toRuntimeWorktreeSelector } from '../runtime/runtime-worktree-selector'
import {
  compareDiskWritePrecondition,
  diskConflictFromReadFailure,
  FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY,
  FILE_WRITE_IF_UNCHANGED_METHOD,
  parseFileWriteResult,
  type FileWriteDiskConflict,
  type FileWriteDiskPrecondition,
  type FileWriteResult
} from '../../../shared/file-write-disk-precondition'

const SSH_OWNER_CHANGED_MESSAGE =
  "Couldn't verify the SSH connection. Reconnect the host and try again."

type WebFileMutationMethod = Pick<
  NonNullable<PreloadApi['fs']>,
  'writeFile' | 'createFile' | 'createDir' | 'rename' | 'copy' | 'deletePath'
>

type ResolvedWebRuntimeFile = {
  worktree: Pick<Worktree, 'id' | 'hostId'>
  relativePath: string
}

type WebFileMutationSession = {
  resolveFilePath: (filePath: string) => Promise<ResolvedWebRuntimeFile>
  /** Resolves to the host's advertised capabilities. */
  assertMutationSupported: () => Promise<readonly string[]>
  callRuntimeResult: (method: string, params: unknown) => Promise<unknown>
  getSshState: (targetId: string) => Promise<SshConnectionState | null>
}

type WebFileMutationDependencies = {
  captureSession: () => WebFileMutationSession
}

type WebFileMutationProvenance = SshMutationExpectation & {
  expectedExecutionHostId: 'local' | `ssh:${string}`
}

async function captureWebFileMutationProvenance(
  file: ResolvedWebRuntimeFile,
  getSshState: WebFileMutationSession['getSshState']
): Promise<WebFileMutationProvenance> {
  const host = parseExecutionHostId(file.worktree.hostId)
  if (file.worktree.hostId !== undefined && !host) {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }
  if (!host || host.kind === 'local' || host.kind === 'runtime') {
    return { expectedExecutionHostId: 'local' }
  }

  const state = await getSshState(host.targetId)
  if (state?.targetId !== host.targetId || state.connectionGeneration === undefined) {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }
  return {
    expectedExecutionHostId: host.id,
    expectedSshTargetId: host.targetId,
    expectedSshConnectionGeneration: state.connectionGeneration
  }
}

function assertSameWorktree(
  source: ResolvedWebRuntimeFile,
  destination: ResolvedWebRuntimeFile
): void {
  if (source.worktree.id !== destination.worktree.id) {
    throw new Error('File operation cannot cross runtime worktrees')
  }
}

/** Paired servers may predate the precondition; read through the same preview the editor loaded from, then compare. */
async function checkWebDiskPreconditionFromClient(
  session: WebFileMutationSession,
  file: ResolvedWebRuntimeFile,
  precondition: FileWriteDiskPrecondition
): Promise<FileWriteDiskConflict | null> {
  let preview: unknown
  try {
    preview = await session.callRuntimeResult('files.readPreview', {
      worktree: toRuntimeWorktreeSelector(file.worktree.id),
      relativePath: file.relativePath
    })
  } catch (error) {
    return diskConflictFromReadFailure(precondition, error)
  }
  const text =
    typeof preview === 'object' &&
    preview !== null &&
    !('isBinary' in preview && preview.isBinary === true) &&
    'content' in preview &&
    typeof preview.content === 'string'
      ? preview.content
      : undefined
  return compareDiskWritePrecondition(precondition, text)
}

export function createWebFileMutationMethods(
  dependencies: WebFileMutationDependencies
): WebFileMutationMethod {
  const callMutation = async (
    session: WebFileMutationSession,
    method: string,
    file: ResolvedWebRuntimeFile,
    params: Record<string, unknown>,
    // Why: lets a capability-gated request branch on the same status the support check fetched.
    refine?: (
      capabilities: readonly string[]
    ) => Promise<{ method: string; params: Record<string, unknown> } | FileWriteResult>
  ): Promise<unknown> => {
    const capabilities = await session.assertMutationSupported()
    const provenance = await captureWebFileMutationProvenance(file, session.getSshState)
    const refined = refine ? await refine(capabilities) : { method, params }
    if ('ok' in refined) {
      return refined
    }
    return session.callRuntimeResult(refined.method, {
      worktree: toRuntimeWorktreeSelector(file.worktree.id),
      ...refined.params,
      ...provenance
    })
  }

  return {
    writeFile: async ({ filePath, content, diskPrecondition }) => {
      const session = dependencies.captureSession()
      const file = await session.resolveFilePath(filePath)
      const params = { relativePath: file.relativePath, content }
      return parseFileWriteResult(
        await callMutation(session, 'files.write', file, params, async (capabilities) => {
          if (!diskPrecondition) {
            return { method: 'files.write', params }
          }
          if (capabilities.includes(FILE_WRITE_DISK_PRECONDITION_RUNTIME_CAPABILITY)) {
            return {
              method: FILE_WRITE_IF_UNCHANGED_METHOD,
              params: { ...params, diskPrecondition }
            }
          }
          const diskConflict = await checkWebDiskPreconditionFromClient(
            session,
            file,
            diskPrecondition
          )
          return diskConflict ? { ok: false, diskConflict } : { method: 'files.write', params }
        })
      )
    },
    createFile: async ({ filePath }) => {
      const session = dependencies.captureSession()
      const file = await session.resolveFilePath(filePath)
      await callMutation(session, 'files.createFile', file, { relativePath: file.relativePath })
    },
    createDir: async ({ dirPath }) => {
      const session = dependencies.captureSession()
      const file = await session.resolveFilePath(dirPath)
      await callMutation(session, 'files.createDir', file, { relativePath: file.relativePath })
    },
    rename: async ({ oldPath, newPath }) => {
      const session = dependencies.captureSession()
      const oldFile = await session.resolveFilePath(oldPath)
      const newFile = await session.resolveFilePath(newPath)
      assertSameWorktree(oldFile, newFile)
      await callMutation(session, 'files.rename', oldFile, {
        oldRelativePath: oldFile.relativePath,
        newRelativePath: newFile.relativePath
      })
    },
    copy: async ({ sourcePath, destinationPath }) => {
      const session = dependencies.captureSession()
      const source = await session.resolveFilePath(sourcePath)
      const destination = await session.resolveFilePath(destinationPath)
      assertSameWorktree(source, destination)
      await callMutation(session, 'files.copy', source, {
        sourceRelativePath: source.relativePath,
        destinationRelativePath: destination.relativePath
      })
    },
    deletePath: async ({ targetPath, recursive }) => {
      const session = dependencies.captureSession()
      const file = await session.resolveFilePath(targetPath)
      await callMutation(session, 'files.delete', file, {
        relativePath: file.relativePath,
        recursive
      })
    }
  }
}
