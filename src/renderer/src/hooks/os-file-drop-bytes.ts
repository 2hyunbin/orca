import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../../shared/agent-session-attachments'
import { createBrowserUuid } from '../lib/browser-uuid'
import type { NativeFileDropCopyFailureReason } from '../../../shared/native-file-drop'
import {
  hasDragTempMarker,
  copyFailure,
  type DroppedPathConsumer,
  type PreparedDroppedPaths
} from '../../../shared/native-file-drop-preparation'

let retainedDrops = 0
type StoredFile = { path: string } | { reason: NativeFileDropCopyFailureReason }
/** Retain sources before awaiting; only main grants physical execution. */
export async function prepareOsFileDrop(
  paths: string[],
  files: File[],
  consumer: DroppedPathConsumer
): Promise<PreparedDroppedPaths | undefined> {
  const candidate = (path: string) =>
    navigator.userAgent.includes('Mac') && hasDragTempMarker(path.split(/[\\/]/))
  const bounded = paths.some(candidate)
  if (bounded && retainedDrops >= 8) {
    return {
      paths: paths.filter((path) => !candidate(path)),
      failures: [copyFailure(paths.filter(candidate).length, 'busy')]
    }
  }
  if (bounded) {
    retainedDrops++
  }
  const controller = new AbortController()
  const gone = () => controller.abort(new DOMException('Window went away', 'AbortError'))
  window.addEventListener('pagehide', gone, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  let prepared: PreparedDroppedPaths = { paths: [], failures: [] }
  const stored = new Map<number, StoredFile>()
  const work = (async () => {
    prepared = await window.api.fs.prepareDroppedPaths({
      paths,
      consumer,
      ...(bounded ? { intakeId: createBrowserUuid() } : {})
    })
    const intake = prepared.intake
    if (!intake) {
      return
    }
    timer = setTimeout(
      () => controller.abort(new Error('timed-out')),
      Math.max(0, intake.expiresAt - Date.now())
    )
    for (const slot of prepared.fromDroppedFiles ?? []) {
      if (stored.has(slot.sourceIndex)) {
        continue
      }
      if (Date.now() >= intake.expiresAt) {
        controller.abort(new Error('timed-out'))
      }
      controller.signal.throwIfAborted()
      const outcome = await storeFileBytes(
        files[slot.sourceIndex],
        slot.byteLength,
        intake.intakeId,
        slot.sourceIndex,
        controller.signal
      )
      if (!controller.signal.aborted && Date.now() < intake.expiresAt) {
        stored.set(slot.sourceIndex, outcome)
      }
    }
  })().finally(() => {
    files.length = 0
    if (bounded) {
      retainedDrops--
    }
    clearTimeout(timer)
    window.removeEventListener('pagehide', gone)
    // This acknowledgement follows actual reader/invoke settlement, even after logical timeout.
    if (prepared.intake) {
      void window.api.fs
        .endDroppedFileIntake({
          intakeId: prepared.intake.intakeId,
          disposition: controller.signal.aborted ? 'abort' : 'complete'
        })
        .catch(() => undefined)
    }
  })
  await waitForPromiseWithSignal(work, controller.signal).catch((error: unknown) => {
    if (!controller.signal.aborted) {
      throw error
    }
  })
  if (controller.signal.reason instanceof DOMException) {
    return undefined
  }
  return reduceDrop(prepared, stored)
}

function reduceDrop(
  prepared: PreparedDroppedPaths,
  stored: Map<number, StoredFile>
): PreparedDroppedPaths {
  const slots = prepared.fromDroppedFiles ?? []
  const paths: string[] = []
  const lost: (NativeFileDropCopyFailureReason | undefined)[] = []
  const slotAt = new Map(slots.map((slot) => [slot.position, slot]))
  let nextPath = 0
  for (let position = 0; position < prepared.paths.length + slots.length; position++) {
    const slot = slotAt.get(position)
    const outcome: StoredFile = slot
      ? (stored.get(slot.sourceIndex) ?? { reason: 'timed-out' })
      : { path: prepared.paths[nextPath++] }
    if ('path' in outcome) {
      paths.push(outcome.path)
    } else {
      lost.push(outcome.reason)
    }
  }
  const failures = prepared.failures.filter((failure) => failure.reason !== 'temp-copy-failed')
  let count = lost.length
  for (const failure of prepared.failures) {
    if (failure.reason === 'temp-copy-failed') {
      count += failure.pathCount
      lost.push(failure.commonReason)
    }
  }
  if (count) {
    failures.push(
      copyFailure(count, lost.every((reason) => reason === lost[0]) ? lost[0] : undefined)
    )
  }
  return { paths, failures }
}

async function storeFileBytes(
  file: File | undefined,
  byteLength: number,
  intakeId: string,
  sourceIndex: number,
  signal: AbortSignal
): Promise<StoredFile> {
  if (!file) {
    return { reason: 'missing' }
  }
  if (
    !Number.isFinite(file.size) ||
    file.size < 0 ||
    file.size > AGENT_SESSION_ATTACHMENT_MAX_BYTES ||
    file.size !== byteLength
  ) {
    return { reason: 'changed' }
  }
  let reading = true
  try {
    const bytes = new Uint8Array(await readDroppedFile(file, signal))
    signal.throwIfAborted()
    if (bytes.byteLength !== byteLength) {
      return { reason: 'changed' }
    }
    reading = false
    const result = await window.api.fs.storeDroppedFileBytes({
      intakeId,
      sourceIndex,
      name: file.name,
      bytes
    })
    return result.paths[0]
      ? { path: result.paths[0] }
      : { reason: result.failures[0]?.commonReason ?? 'copy-failed' }
  } catch (error) {
    signal.throwIfAborted()
    return {
      reason: !reading
        ? 'copy-failed'
        : error instanceof DOMException && error.name === 'NotFoundError'
          ? 'missing'
          : 'changed'
    }
  }
}

function readDroppedFile(file: File, signal: AbortSignal): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    let settled = false
    const finish = () => {
      if (settled) {
        return
      }
      settled = true
      reader.onloadend = null
      signal.removeEventListener('abort', abort)
      if (signal.aborted) {
        reject(signal.reason)
      } else if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result)
      } else {
        reject(reader.error ?? new Error('File read failed'))
      }
    }
    const abort = () => {
      reader.abort()
      finish()
    }
    reader.onloadend = finish
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    } else {
      reader.readAsArrayBuffer(file)
    }
  })
}
