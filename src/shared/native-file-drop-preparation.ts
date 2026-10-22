import type {
  NativeFileDropRejectedPayload,
  NativeFileDropCopyFailureReason
} from './native-file-drop'

export const OS_FILE_DROP_OWNER_ATTRIBUTE = 'data-os-file-drop-owner'

export type DroppedPathConsumer = 'agent' | 'main-reader' | 'local-chat'

export type PrepareDroppedPathsRequest = {
  paths: string[]
  consumer: DroppedPathConsumer
  intakeId?: string
}

/** A checked drag-temp file a local chat takes as the dropped File's own bytes. */
export type DroppedFileBytesSlot = {
  /** Index in the request's paths (its first occurrence) of the file to read. */
  sourceIndex: number
  byteLength: number
  /** Where the stored path goes in the drop's final `paths`. */
  position: number
}

export type PreparedDroppedPaths = {
  paths: string[]
  failures: NativeFileDropRejectedPayload[]
  intake?: { intakeId: string; expiresAt: number }
  /** Local chat only: files to send with `storeDroppedFileBytes`, then place into `paths`. */
  fromDroppedFiles?: DroppedFileBytesSlot[]
}

export type StoreDroppedFileBytesRequest = {
  intakeId: string
  sourceIndex: number
  name: string
  bytes: Uint8Array
}

export type EndDroppedFileIntakeRequest = {
  intakeId: string
  disposition: 'complete' | 'abort'
}

export function hasDragTempMarker(segments: readonly string[]): boolean {
  return segments.some(
    (segment, index) =>
      segment === 'TemporaryItems' &&
      segments[index + 1]?.startsWith('NSIRD_') &&
      index + 2 < segments.length
  )
}

export function copyFailure(
  pathCount: number,
  commonReason?: NativeFileDropCopyFailureReason
): NativeFileDropRejectedPayload {
  return {
    byteLength: 0,
    pathCount,
    reason: 'temp-copy-failed',
    target: 'rejected',
    ...(commonReason ? { commonReason } : {})
  }
}
