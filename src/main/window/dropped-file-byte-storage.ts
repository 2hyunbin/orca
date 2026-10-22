import { copyFailure } from '../../shared/native-file-drop-preparation'
import type {
  StoreDroppedFileBytesRequest,
  PreparedDroppedPaths
} from '../../shared/native-file-drop-preparation'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { DragTempCopyBatch, stageCapturedDragTempBytes } from './dragged-temp-file-copy'
import type { DropJob } from './dropped-path-preparation'

export async function storeDroppedFileBytes(
  request: StoreDroppedFileBytesRequest,
  job: DropJob
): Promise<PreparedDroppedPaths> {
  const signal = job.controller.signal
  const bytes = Buffer.from(
    request.bytes.buffer,
    request.bytes.byteOffset,
    request.bytes.byteLength
  )
  job.check()
  if (!job.store) {
    try {
      job.store = job.deps.localChatAttachmentStore?.() ?? Promise.resolve(null)
    } catch {
      job.store = Promise.resolve(null)
    }
  }
  const store = await waitForPromiseWithSignal(job.store, signal).catch(() => {
    job.check()
    return null
  })
  job.check()
  if (store) {
    try {
      const path = await store.storeFile(request.name, bytes, signal)
      // A committed rename is never turned into a fallback, even if abort won publication.
      if (Date.now() >= job.expiresAt) {
        job.finish('timed-out')
      }
      return signal.aborted
        ? { paths: [], failures: [copyFailure(1, 'timed-out')] }
        : { paths: [path], failures: [] }
    } catch {
      job.check()
    }
  }
  job.check()
  const env = await waitForPromiseWithSignal(job.deps.getCopyEnvironment(), signal)
  job.check()
  const staged = await stageCapturedDragTempBytes(
    request.name,
    bytes,
    env,
    new DragTempCopyBatch(),
    signal
  )
  return staged.status === 'imported'
    ? { paths: [staged.destPath], failures: [] }
    : {
        paths: [],
        failures: [copyFailure(1, staged.status === 'failed' ? staged.reason : undefined)]
      }
}
