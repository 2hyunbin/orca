import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../shared/agent-session-attachments'
import type { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import type { NativeFileDropCopyFailureReason } from '../../shared/native-file-drop'
import type {
  DroppedFileBytesSlot,
  PrepareDroppedPathsRequest,
  PreparedDroppedPaths,
  StoreDroppedFileBytesRequest
} from '../../shared/native-file-drop-preparation'
import {
  DragTempCopyBatch,
  stageCapturedDragTempBytes,
  materializeDragTempPaths,
  removeCreatedDragTempCopies,
  type DragTempCopyItemResult,
  mayNeedDragTempCopy,
  type DragTempCopyEnvironment
} from './dragged-temp-file-copy'

const DRAG_TEMP_COPY_TIMEOUT_MS = 2 * 60 * 1000
export const MAX_PENDING_DRAG_TEMP_COPIES = 8

export type RendererDropLifetime = { signal: AbortSignal; dispose: () => void }
export type DroppedPathPreparationDeps = {
  platform: NodeJS.Platform
  getCopyEnvironment: () => Promise<DragTempCopyEnvironment>
  watchRenderer: () => RendererDropLifetime
  localChatAttachmentStore?: () => Promise<Pick<AgentSessionAttachmentStore, 'storeFile'> | null>
  copyTimeoutMs?: number
}

export function createDragTempCopyLane(): { tail: Promise<void>; pending: number } {
  return { tail: Promise.resolve(), pending: 0 }
}

// Why: replacement windows share the copy queue with work already in flight.
export const windowDragTempCopyLane = createDragTempCopyLane()

export function createDroppedPathPreparationQueue(
  deps: DroppedPathPreparationDeps,
  lane = createDragTempCopyLane()
): (request: PrepareDroppedPathsRequest) => PreparedDroppedPaths | Promise<PreparedDroppedPaths> {
  return (request) => {
    if (!request.paths.some((path) => mayNeedDragTempCopy(path, deps.platform))) {
      return { paths: [...request.paths], failures: [] }
    }
    return enqueueDropWork(
      deps,
      lane,
      (signal) =>
        deps.getCopyEnvironment().then((env) => prepareDroppedPaths(request, env, signal)),
      (reason) => failDroppedPathPreparation(request.paths, deps.platform, reason)
    )
  }
}

/** A local chat's dropped file, sent as the File's bytes: written once into the chat store. */
export function createDroppedFileBytesIntake(
  deps: DroppedPathPreparationDeps,
  lane = createDragTempCopyLane()
): (request: StoreDroppedFileBytesRequest) => PreparedDroppedPaths | Promise<PreparedDroppedPaths> {
  return (request) =>
    enqueueDropWork(
      deps,
      lane,
      (signal) => storeDroppedFileBytes(request, signal, deps),
      (reason) => ({ paths: [], failures: [copyFailure(1, reason)] })
    )
}

export async function prepareDroppedPaths(
  request: PrepareDroppedPathsRequest,
  env: DragTempCopyEnvironment,
  signal?: AbortSignal
): Promise<PreparedDroppedPaths> {
  const batch = new DragTempCopyBatch(
    request.consumer === 'local-chat' ? AGENT_SESSION_ATTACHMENT_MAX_BYTES : -1
  )
  let prepared: DragTempCopyItemResult[]
  try {
    const capture = materializeDragTempPaths(request.paths, env, signal, batch)
    prepared = await (signal ? rejectOnDropAbort(capture, signal) : capture)
    signal?.throwIfAborted()
  } catch (error) {
    await removeCreatedDragTempCopies(batch.directories)
    throw error
  } finally {
    batch.completed.clear()
  }
  const acceptsOriginal = request.consumer === 'main-reader'
  const paths: string[] = []
  const fromDroppedFiles: DroppedFileBytesSlot[] = []
  const unprepared: Extract<DragTempCopyItemResult, { status: 'uncopied' | 'failed' }>[] = []
  for (const result of prepared) {
    if (result.status === 'imported') {
      paths.push(result.destPath)
    } else if (result.status === 'uncopied' && acceptsOriginal) {
      paths.push(result.sourcePath)
    } else if (result.status === 'from-file') {
      fromDroppedFiles.push({
        // Why first occurrence: a path dropped twice is read and stored once.
        sourceIndex: request.paths.indexOf(result.sourcePath),
        byteLength: result.byteLength,
        position: paths.length + fromDroppedFiles.length
      })
    } else {
      unprepared.push(result)
    }
  }
  const commonReason = unprepared.every((item) => item.reason === unprepared[0]?.reason)
    ? unprepared[0]?.reason
    : undefined
  return {
    paths,
    failures: unprepared.length > 0 ? [copyFailure(unprepared.length, commonReason)] : [],
    ...(fromDroppedFiles.length > 0 ? { fromDroppedFiles } : {})
  }
}

async function storeDroppedFileBytes(
  request: StoreDroppedFileBytesRequest,
  signal: AbortSignal,
  deps: DroppedPathPreparationDeps
): Promise<PreparedDroppedPaths> {
  const bytes = Buffer.from(
    request.bytes.buffer,
    request.bytes.byteOffset,
    request.bytes.byteLength
  )
  const getStore = deps.localChatAttachmentStore?.().catch(() => null) ?? Promise.resolve(null)
  // Why abortable: a chat host that never finishes starting must not hold the lane past the deadline.
  const store = await rejectOnDropAbort(getStore, signal)
  if (store) {
    try {
      const stored = await store.storeFile(request.name, bytes)
      signal.throwIfAborted()
      return { paths: [stored], failures: [] }
    } catch {
      signal.throwIfAborted()
    }
  }
  // Store unavailable or its write failed: keep the received bytes as a private copy by path.
  const staged = await stageCapturedDragTempBytes(
    request.name,
    bytes,
    await deps.getCopyEnvironment(),
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

function enqueueDropWork(
  deps: DroppedPathPreparationDeps,
  lane: { tail: Promise<void>; pending: number },
  work: (signal: AbortSignal) => Promise<PreparedDroppedPaths>,
  fail: (reason?: NativeFileDropCopyFailureReason) => PreparedDroppedPaths
): PreparedDroppedPaths | Promise<PreparedDroppedPaths> {
  if (lane.pending >= MAX_PENDING_DRAG_TEMP_COPIES) {
    return fail('busy')
  }
  const lifetime = deps.watchRenderer()
  lane.pending += 1
  const prepared = lane.tail.then(() => {
    lifetime.signal.throwIfAborted()
    return runWithinDropDeadline(lifetime.signal, deps, work, fail)
  })
  lane.tail = prepared
    .then(
      () => undefined,
      () => undefined
    )
    .finally(() => {
      lane.pending -= 1
      lifetime.dispose()
    })
  // Why: a reloaded document must stop waiting even while its request is queued.
  return rejectOnDropAbort(prepared, lifetime.signal)
}

function failDroppedPathPreparation(
  paths: readonly string[],
  platform: NodeJS.Platform,
  reason?: NativeFileDropCopyFailureReason
): PreparedDroppedPaths {
  const ordinary = paths.filter((path) => !mayNeedDragTempCopy(path, platform))
  const lost = paths.length - ordinary.length
  return {
    paths: ordinary,
    failures: lost > 0 ? [copyFailure(lost, reason)] : []
  }
}

async function runWithinDropDeadline(
  rendererSignal: AbortSignal,
  deps: DroppedPathPreparationDeps,
  work: (signal: AbortSignal) => Promise<PreparedDroppedPaths>,
  fail: (reason?: NativeFileDropCopyFailureReason) => PreparedDroppedPaths
): Promise<PreparedDroppedPaths> {
  const timeout = new AbortController()
  const timer = setTimeout(
    () => timeout.abort(new Error('Copying the dropped files took too long')),
    deps.copyTimeoutMs ?? DRAG_TEMP_COPY_TIMEOUT_MS
  )
  const signal = AbortSignal.any([rendererSignal, timeout.signal])
  try {
    return await rejectOnDropAbort(work(signal), signal)
  } catch (error) {
    if (rendererSignal.aborted) {
      throw error
    }
    return fail(timeout.signal.aborted ? 'timed-out' : undefined)
  } finally {
    clearTimeout(timer)
  }
}

export function rejectOnDropAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    if (signal.aborted) {
      onAbort()
    } else {
      signal.addEventListener('abort', onAbort, { once: true })
    }
    void work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function copyFailure(pathCount: number, commonReason?: NativeFileDropCopyFailureReason) {
  return {
    byteLength: 0,
    pathCount,
    reason: 'temp-copy-failed' as const,
    target: 'rejected' as const,
    ...(commonReason ? { commonReason } : {})
  }
}
