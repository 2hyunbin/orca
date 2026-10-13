import type { BigIntStats } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  AuthorizedFilePathError,
  openAuthorizedRegularFile,
  sameRegularFileIdentity
} from '../authorized-regular-file'
import {
  PLUGIN_VIEWER_CHUNK_BYTES,
  PLUGIN_VIEWER_DOCUMENT_BYTES,
  PluginViewerDocumentError
} from './plugin-viewer-document'

export type PluginViewerFileRequest = { boundaryPath: string; entryPath: string }

export type PluginViewerFileResource = {
  name: string
  size: number
  read(position: number, length: number, signal: AbortSignal): Promise<Buffer>
  close(): Promise<void>
}

function sameRevision(initial: BigIntStats, current: BigIntStats): boolean {
  return (
    current.isFile() &&
    sameRegularFileIdentity(initial, current) &&
    initial.size === current.size &&
    initial.mtimeNs === current.mtimeNs &&
    initial.ctimeNs === current.ctimeNs
  )
}

export async function openPluginViewerFileResource(
  request: PluginViewerFileRequest,
  signal: AbortSignal
): Promise<PluginViewerFileResource> {
  request = { ...request }
  signal.throwIfAborted()
  const file = await openAuthorizedRegularFile({
    ...request,
    targetPath: request.entryPath,
    implicitRootPath: null,
    authorizedRootPaths: []
  }).catch((error) => {
    if (error instanceof AuthorizedFilePathError) {
      throw new PluginViewerDocumentError('unauthorized')
    }
    throw error
  })
  try {
    signal.throwIfAborted()
    const initial = await file.handle.stat({ bigint: true })
    if (initial.size < 0n || initial.size > BigInt(PLUGIN_VIEWER_DOCUMENT_BYTES)) {
      throw new PluginViewerDocumentError('limit_exceeded')
    }
    const size = Number(initial.size)
    const inspect = async (): Promise<void> => {
      signal.throwIfAborted()
      const [opened, target, boundary, current] = await Promise.all([
        file.handle.stat({ bigint: true }),
        realpath(request.entryPath),
        realpath(request.boundaryPath),
        stat(file.canonicalTarget, { bigint: true })
      ]).catch(() => {
        throw new PluginViewerDocumentError('stale_revision')
      })
      signal.throwIfAborted()
      if (
        target !== file.canonicalTarget ||
        boundary !== file.canonicalBoundary ||
        !sameRevision(initial, opened) ||
        !sameRevision(initial, current)
      ) {
        throw new PluginViewerDocumentError('stale_revision')
      }
    }
    await inspect()
    return {
      name: basename(request.entryPath),
      size,
      async read(position, length, readSignal) {
        if (
          !Number.isSafeInteger(position) ||
          position < 0 ||
          !Number.isSafeInteger(length) ||
          length < 1 ||
          length > PLUGIN_VIEWER_CHUNK_BYTES ||
          !Number.isSafeInteger(position + length)
        ) {
          throw new PluginViewerDocumentError('invalid_request')
        }
        readSignal.throwIfAborted()
        await inspect()
        const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - position)))
        let offset = 0
        while (offset < buffer.length) {
          readSignal.throwIfAborted()
          const { bytesRead } = await file.handle.read({
            buffer,
            offset,
            length: buffer.length - offset,
            position: position + offset
          })
          readSignal.throwIfAborted()
          if (bytesRead === 0) {
            throw new PluginViewerDocumentError('stale_revision')
          }
          offset += bytesRead
        }
        await inspect()
        readSignal.throwIfAborted()
        return buffer
      },
      close: () => file.handle.close()
    }
  } catch (error) {
    await file.handle.close()
    throw error
  }
}
