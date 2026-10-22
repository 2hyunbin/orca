import { randomUUID } from 'node:crypto'
import { storeDroppedFileBytes } from './dropped-file-byte-storage'
import { copyFailure } from '../../shared/native-file-drop-preparation'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../shared/agent-session-attachments'
import type { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import type { NativeFileDropCopyFailureReason } from '../../shared/native-file-drop'
import type {
  DroppedFileBytesSlot,
  PrepareDroppedPathsRequest,
  PreparedDroppedPaths,
  StoreDroppedFileBytesRequest,
  EndDroppedFileIntakeRequest
} from '../../shared/native-file-drop-preparation'
import {
  DragTempCopyBatch,
  materializeDragTempPaths,
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
type DropLane = { jobs: Map<string, DropJob>; active?: DropJob; physical?: DropJob }
export function createDragTempCopyLane(): DropLane {
  return { jobs: new Map() }
}
// Why: replacement documents share admission and the outstanding physical drain.
export const windowDragTempCopyLane = createDragTempCopyLane()
function advance(lane: DropLane): void {
  if (!lane.active) {
    lane.active = [...lane.jobs.values()].find((job) => !job.ended && !job.expiresAt)
    lane.active?.start()
  }
}

export class DropJob {
  readonly id: string
  readonly controller = new AbortController()
  readonly result = Promise.withResolvers<PreparedDroppedPaths>()
  readonly drain = Promise.withResolvers<void>()
  readonly lifetime: RendererDropLifetime
  readonly slots = new Map<number, number>()
  store?: ReturnType<NonNullable<DroppedPathPreparationDeps['localChatAttachmentStore']>>
  ended = false
  working = false
  sourceReleased = true
  expiresAt = 0
  private timer?: ReturnType<typeof setTimeout>
  constructor(
    readonly request: PrepareDroppedPathsRequest,
    readonly deps: DroppedPathPreparationDeps,
    readonly lane: DropLane
  ) {
    this.id = request.intakeId ?? randomUUID()
    this.lifetime = deps.watchRenderer()
    this.lifetime.signal.addEventListener('abort', this.gone, { once: true })
  }
  readonly gone = (): void => {
    this.sourceReleased = true
    this.finish('copy-failed')
    this.releaseDrained()
  }
  releaseDrained(): void {
    if (!this.ended || this.working || !this.sourceReleased || !this.lane.jobs.has(this.id)) {
      return
    }
    this.lifetime.signal.removeEventListener('abort', this.gone)
    this.lifetime.dispose()
    this.lane.jobs.delete(this.id)
    if (this.lane.physical === this) {
      this.lane.physical = undefined
    }
    this.drain.resolve()
  }
  finish(reason?: NativeFileDropCopyFailureReason): void {
    if (this.ended) {
      return
    }
    this.ended = true
    clearTimeout(this.timer)
    this.controller.abort(new Error(reason ?? 'Dropped file intake ended'))
    if (this.lifetime.signal.aborted) {
      this.result.reject(this.lifetime.signal.reason)
    } else {
      this.result.resolve(
        failDroppedPathPreparation(this.request.paths, this.deps.platform, reason)
      )
    }
    if (this.lane.active === this) {
      this.lane.active = undefined
    }
    this.releaseDrained()
    advance(this.lane)
  }
  check(): void {
    if (Date.now() >= this.expiresAt) {
      this.finish('timed-out')
    }
    this.controller.signal.throwIfAborted()
  }
  async perform<T>(work: () => Promise<T>): Promise<T> {
    this.working = true
    try {
      return await work()
    } finally {
      this.working = false
      this.releaseDrained()
    }
  }
  start(): void {
    this.expiresAt = Date.now() + (this.deps.copyTimeoutMs ?? DRAG_TEMP_COPY_TIMEOUT_MS)
    this.timer = setTimeout(
      () => this.finish('timed-out'),
      Math.max(0, this.expiresAt - Date.now())
    )
    void this.perform(async () => {
      const signal = this.controller.signal
      if (this.lane.physical) {
        await waitForPromiseWithSignal(this.lane.physical.drain.promise, signal)
      }
      this.check()
      this.lane.physical = this
      const env = await waitForPromiseWithSignal(this.deps.getCopyEnvironment(), signal)
      this.check()
      return prepareDroppedPaths(this.request, env, signal)
    })
      .then((prepared) => {
        this.check()
        if (prepared.fromDroppedFiles?.length) {
          for (const slot of prepared.fromDroppedFiles) {
            this.slots.set(slot.sourceIndex, slot.byteLength)
          }
          this.sourceReleased = false
          this.result.resolve({
            ...prepared,
            intake: { intakeId: this.id, expiresAt: this.expiresAt }
          })
        } else {
          this.result.resolve(prepared)
          this.finish()
        }
      })
      .catch(() => this.finish(this.controller.signal.aborted ? 'timed-out' : 'copy-failed'))
  }
}

export function createDroppedPathPreparationQueue(
  deps: DroppedPathPreparationDeps,
  lane = createDragTempCopyLane()
) {
  return (
    request: PrepareDroppedPathsRequest
  ): PreparedDroppedPaths | Promise<PreparedDroppedPaths> => {
    if (!request.paths.some((path) => mayNeedDragTempCopy(path, deps.platform))) {
      return { paths: [...request.paths], failures: [] }
    }
    if (request.intakeId && lane.jobs.has(request.intakeId)) {
      throw new Error('Dropped file intake is already registered')
    }
    if (
      [...lane.jobs.values()].filter((job) => !job.ended).length >= MAX_PENDING_DRAG_TEMP_COPIES
    ) {
      return failDroppedPathPreparation(request.paths, deps.platform, 'busy')
    }
    const job = new DropJob(request, deps, lane)
    lane.jobs.set(job.id, job)
    if (job.lifetime.signal.aborted) {
      job.gone()
    } else {
      advance(lane)
    }
    return job.result.promise
  }
}
export function endDroppedFileIntake(
  deps: DroppedPathPreparationDeps,
  lane: DropLane,
  request: EndDroppedFileIntakeRequest
): void {
  const job = lane.jobs.get(request.intakeId)
  if (!job || job.deps !== deps) {
    return
  }
  job.sourceReleased = true
  job.finish(request.disposition === 'abort' ? 'copy-failed' : undefined)
  job.releaseDrained()
}
export function createDroppedFileBytesIntake(
  deps: DroppedPathPreparationDeps,
  lane = createDragTempCopyLane()
) {
  return (request: StoreDroppedFileBytesRequest): Promise<PreparedDroppedPaths> => {
    const job = lane.jobs.get(request.intakeId)
    if (
      !job ||
      job.deps !== deps ||
      job.ended ||
      lane.active !== job ||
      job.working ||
      job.slots.get(request.sourceIndex) !== request.bytes.byteLength ||
      request.bytes.byteLength > AGENT_SESSION_ATTACHMENT_MAX_BYTES
    ) {
      throw new Error('Invalid dropped file continuation')
    }
    job.check()
    job.slots.delete(request.sourceIndex)
    return waitForPromiseWithSignal(
      job.perform(() => storeDroppedFileBytes(request, job)),
      job.controller.signal
    ).catch(() => ({
      paths: [],
      failures: [copyFailure(1, job.controller.signal.aborted ? 'timed-out' : 'copy-failed')]
    }))
  }
}

export async function prepareDroppedPaths(
  request: PrepareDroppedPathsRequest,
  env: DragTempCopyEnvironment,
  signal?: AbortSignal
): Promise<PreparedDroppedPaths> {
  const batch = new DragTempCopyBatch(
    request.consumer === 'local-chat' && request.intakeId ? AGENT_SESSION_ATTACHMENT_MAX_BYTES : -1
  )
  const prepared = await materializeDragTempPaths(request.paths, env, signal, batch)
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
