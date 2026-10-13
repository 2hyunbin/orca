import { posix, win32 } from 'node:path'
import { isRuntimePathAbsolute, isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../shared/execution-host'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { getPreferredPairedRuntimeConnection } from '../../shared/runtime-environments'
import { PluginViewerDocumentError } from '../../shared/plugins/plugin-viewer-document'
import { PluginViewerRuntimeClient } from '../../shared/plugins/plugin-viewer-runtime-client'
import type { PluginViewerOpenRequest } from '../../shared/plugins/plugin-viewer-open'
import type { PluginViewerFileRequest } from '../../shared/plugins/plugin-viewer-file-resource'
import type { PluginViewerFileAuthority } from '../plugins/plugin-viewer-file-authority'
import { resolveManagedRuntimeEnvironment } from './runtime-environment-managed-tunnel'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { runtimeEnvironmentRevisionFailure } from './runtime-environment-revision-guard'
import {
  getRuntimeEnvironmentTransportGeneration,
  onRuntimeEnvironmentTransportChanged
} from './runtime-environment-transport-generation'

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
  const environment = resolveEnvironment(userDataPath, host.environmentId)
  const generation = getRuntimeEnvironmentTransportGeneration(environment.id)
  let fingerprint: string | null = null
  let retired = false
  let client: PluginViewerRuntimeClient | null = null
  const listeners = new Set<() => void>()
  const isCurrent = (): boolean => {
    try {
      const current = resolveEnvironment(userDataPath, environment.id)
      return (
        !retired &&
        environment.id === host.environmentId &&
        !isRuntimeEnvironmentManuallyDisconnected(environment.id) &&
        getRuntimeEnvironmentTransportGeneration(environment.id) === generation &&
        (fingerprint === null ||
          JSON.stringify(getPreferredPairedRuntimeConnection(current)) === fingerprint) &&
        !runtimeEnvironmentRevisionFailure(
          current,
          request.expectedEnvironmentPairingRevision,
          'files.pluginViewer.open',
          request.expectedEnvironmentRuntimeId
        )
      )
    } catch {
      return false
    }
  }
  if (!isCurrent()) {
    throw new PluginViewerDocumentError('unauthorized')
  }
  const prepared = await resolveManagedRuntimeEnvironment(userDataPath, environment.id)
  if (!isCurrent()) {
    throw new PluginViewerDocumentError('unauthorized')
  }
  const pairing = getPreferredPairedRuntimeConnection(prepared)
  fingerprint = JSON.stringify(pairing)
  // This boundary is only an opaque route identity; the host derives actual file authority.
  const file = Object.freeze({
    boundaryPath: (isWindowsAbsolutePathLike(request.filePath) ? win32 : posix).dirname(
      request.filePath
    ),
    entryPath: request.filePath
  })
  const invalidate = (): void => {
    if (retired) {
      return
    }
    retired = true
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
        const stop = onRuntimeEnvironmentTransportChanged(environment.id, invalidate)
        if (!isCurrent()) {
          if (retired) {
            listener()
          } else {
            invalidate()
          }
        }
        return () => {
          stop()
          listeners.delete(listener)
          if (listeners.size === 0) {
            retired = true
            client?.close()
          }
        }
      }
    }
  }
}
