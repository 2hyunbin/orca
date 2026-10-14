import { posix, win32 } from 'node:path'
import { isRuntimePathAbsolute, isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../shared/execution-host'
import { PluginViewerDocumentError } from '../../shared/plugins/plugin-viewer-document'
import { PluginViewerRuntimeClient } from '../../shared/plugins/plugin-viewer-runtime-client'
import type { PluginViewerOpenRequest } from '../../shared/plugins/plugin-viewer-open'
import type { PluginViewerFileRequest } from '../../shared/plugins/plugin-viewer-file-resource'
import type { PluginViewerFileAuthority } from '../plugins/plugin-viewer-file-authority'
import {
  prepareRuntimeEnvironmentConnectionLease,
  RuntimeEnvironmentConnectionChangedError
} from './runtime-environment-connection-lease'

export async function resolvePluginViewerRuntimeFileRoute(
  userDataPath: string,
  request: PluginViewerOpenRequest
): Promise<{ file: PluginViewerFileRequest; authority: PluginViewerFileAuthority }> {
  request = structuredClone(request)
  const host = parseExecutionHostId(request.executionHostId)
  if (
    host?.kind !== 'runtime' ||
    request.executionHostId !== toRuntimeExecutionHostId(host.environmentId) ||
    request.expectedEnvironmentPairingRevision === undefined ||
    !request.expectedEnvironmentRuntimeId ||
    request.expectedSshConnectionGeneration !== undefined ||
    !isRuntimePathAbsolute(request.filePath)
  ) {
    throw new PluginViewerDocumentError('unauthorized')
  }
  const runtimeId = request.expectedEnvironmentRuntimeId
  let retired = false
  let client: PluginViewerRuntimeClient | null = null
  const listeners = new Set<() => void>()
  let lease: Awaited<ReturnType<typeof prepareRuntimeEnvironmentConnectionLease>> | null = null
  lease = await prepareRuntimeEnvironmentConnectionLease(
    userDataPath,
    {
      environmentId: host.environmentId,
      pairingRevision: request.expectedEnvironmentPairingRevision,
      runtimeId
    },
    () => invalidate()
  ).catch((error: unknown) => {
    if (error instanceof RuntimeEnvironmentConnectionChangedError) {
      throw new PluginViewerDocumentError('unauthorized')
    }
    throw error
  })
  const isCurrent = (): boolean => !retired && lease?.isCurrent() === true
  const pairing = lease.pairing
  // This boundary is only an opaque route identity; the host derives actual file authority.
  const file = Object.freeze({
    boundaryPath: (isWindowsAbsolutePathLike(request.filePath) ? win32 : posix).dirname(
      request.filePath
    ),
    entryPath: request.filePath
  })
  function invalidate(): void {
    if (retired) {
      return
    }
    retired = true
    lease?.close()
    client?.close()
    for (const listener of Array.from(listeners)) {
      try {
        listener()
      } catch (error) {
        console.warn('[plugins] runtime viewer retirement failed:', error)
      }
    }
  }
  return {
    file,
    authority: {
      isCurrent,
      openFile: async (openedFile, signal, owner) => {
        if (
          !isCurrent() ||
          client ||
          owner.executionHostId !== request.executionHostId ||
          owner.workspaceId !== request.workspaceId ||
          openedFile.boundaryPath !== file.boundaryPath ||
          openedFile.entryPath !== file.entryPath
        ) {
          throw new PluginViewerDocumentError('unauthorized')
        }
        client = new PluginViewerRuntimeClient(pairing, runtimeId, invalidate)
        const resource = await client.open(owner, request.filePath, signal, {
          userSelectedFile: request.access?.kind === 'user-file'
        })
        if (!isCurrent()) {
          await resource.close()
          throw new PluginViewerDocumentError('unauthorized')
        }
        return resource
      },
      onInvalidated: (listener) => {
        listeners.add(listener)
        if (!isCurrent()) {
          if (retired) {
            listener()
          } else {
            invalidate()
          }
        }
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) {
            retired = true
            lease?.close()
            client?.close()
          }
        }
      }
    }
  }
}
