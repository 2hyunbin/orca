import type { NativeFileDropRejectedPayload } from './native-file-drop'

export const OS_FILE_DROP_OWNER_ATTRIBUTE = 'data-os-file-drop-owner'

export type DroppedPathConsumer = 'agent' | 'main-reader' | 'local-chat'

export type PrepareDroppedPathsRequest = {
  paths: string[]
  consumer: DroppedPathConsumer
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
  /** Local chat only: files to send with `storeDroppedFileBytes`, then place into `paths`. */
  fromDroppedFiles?: DroppedFileBytesSlot[]
}

export type StoreDroppedFileBytesRequest = {
  name: string
  bytes: Uint8Array
}
