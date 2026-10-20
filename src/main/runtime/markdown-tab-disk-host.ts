/**
 * Where a phone's Markdown tab file is read and written: this machine's disk for a local workspace,
 * and for a paired server's (`runtime:<env>`) the same `files.read` / `files.writeIfUnchanged` calls
 * the desktop editor makes, so that server reads its own disk and does the compare-and-write itself.
 * A raw `ssh:` host is refused on both, by the route every local file command takes.
 */
import { parseFileWriteResult } from '../../shared/file-write-disk-precondition'
import type {
  FileWriteDiskPrecondition,
  FileWriteResult
} from '../../shared/file-write-disk-precondition'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { utf8ByteLength } from '../../shared/mobile-markdown-document'
import type { PersistedOpenFile } from '../../shared/workspace-session-state-types'
import { OrchestrationError } from './orchestration/orchestration-error'
import { isBinaryBuffer } from '../../shared/binary-buffer'
import { parseExecutionHostId } from '../../shared/execution-host'
import { readLocalRuntimeFilePrefix } from './files/file-reads'
import {
  requireLocalRuntimeFileRoute,
  requireRuntimeFileProvider,
  type ResolvedRuntimeFileTarget,
  type RuntimeLocalFileHost
} from './files/file-target'
import type { MarkdownDiskFile, MarkdownTabDiskHost } from './markdown-tab-disk-documents'

type EnvironmentCall = (environmentId: string, method: string, params: unknown) => Promise<unknown>

export type MarkdownTabDiskRuntime = RuntimeLocalFileHost &
  Pick<MarkdownTabDiskHost, 'getWorkspaceSessionForWorktree'> & {
    resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget>
    callEnvironment: EnvironmentCall
  }

export function createMarkdownTabDiskHost(runtime: MarkdownTabDiskRuntime): MarkdownTabDiskHost {
  const routeOf = async (worktreeId: string) => {
    const target = await runtime.resolveRuntimeFileTarget(`id:${worktreeId}`)
    const host = parseExecutionHostId(target.executionHostId)
    if (host?.kind === 'runtime') {
      return { environmentId: host.environmentId, target }
    }
    requireLocalRuntimeFileRoute(target)
    return { environmentId: null, target }
  }
  return {
    getWorkspaceSessionForWorktree: (worktreeId) =>
      runtime.getWorkspaceSessionForWorktree(worktreeId),
    readFile: async (worktreeId, file, maxBytes) => {
      const { environmentId } = await routeOf(worktreeId)
      if (environmentId) {
        return readFileOnEnvironment(runtime.callEnvironment, environmentId, worktreeId, file)
      }
      const { bytes, size } = await readLocalRuntimeFilePrefix(
        file.filePath,
        runtime.requireStore(),
        maxBytes
      )
      if (isBinaryBuffer(bytes)) {
        throw new Error('binary_file')
      }
      return { content: bytes.toString('utf8'), byteLength: size }
    },
    writeFileIfUnchanged: async (worktreeId, file, content, precondition) => {
      const { environmentId, target } = await routeOf(worktreeId)
      if (environmentId) {
        return writeFileOnEnvironment(
          runtime.callEnvironment,
          environmentId,
          worktreeId,
          file,
          content,
          precondition
        )
      }
      return requireRuntimeFileProvider(target, runtime).writeFileWithDiskPrecondition(
        file.filePath,
        content,
        precondition
      )
    }
  }
}

type MarkdownFileAddress = Pick<PersistedOpenFile, 'relativePath'>

/** The server's answer passes through; losing it is `remote_runtime_unavailable`, never a disk verdict. */
async function callEnvironment(
  call: EnvironmentCall,
  environmentId: string,
  method: string,
  params: unknown
): Promise<unknown> {
  try {
    return await call(environmentId, method, params)
  } catch (error) {
    if (error instanceof OrchestrationError && error.code !== 'server_required') {
      throw error
    }
    throw new RemoteRuntimeClientError(
      'remote_runtime_unavailable',
      error instanceof Error ? error.message : String(error)
    )
  }
}

async function readFileOnEnvironment(
  call: EnvironmentCall,
  environmentId: string,
  worktreeId: string,
  file: MarkdownFileAddress
): Promise<MarkdownDiskFile> {
  const address = { worktree: `id:${worktreeId}`, relativePath: file.relativePath }
  const read = await callEnvironment(call, environmentId, 'files.read', address)
  if (!isRecord(read) || typeof read.content !== 'string') {
    throw new Error('invalid_runtime_response')
  }
  const cut = utf8ByteLength(read.content)
  if (read.truncated !== true) {
    return { content: read.content, byteLength: cut }
  }
  // Why: a truncated `files.read` reports where it cut, not the file size the phone labels.
  const stat = await callEnvironment(call, environmentId, 'files.stat', address)
  const size = isRecord(stat) && typeof stat.size === 'number' ? stat.size : 0
  return { content: read.content, byteLength: Math.max(size, cut + 1) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function writeFileOnEnvironment(
  call: EnvironmentCall,
  environmentId: string,
  worktreeId: string,
  file: MarkdownFileAddress,
  content: string,
  diskPrecondition: FileWriteDiskPrecondition
): Promise<FileWriteResult> {
  return parseFileWriteResult(
    await callEnvironment(call, environmentId, 'files.writeIfUnchanged', {
      worktree: `id:${worktreeId}`,
      relativePath: file.relativePath,
      content,
      // Why `local`: the server writes only a workspace it runs itself, so the write never hops on.
      expectedExecutionHostId: 'local',
      diskPrecondition
    })
  )
}
