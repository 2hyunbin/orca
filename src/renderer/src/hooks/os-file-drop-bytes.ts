// A local chat takes a macOS drag-temp drop (a screenshot thumbnail) the way the common pattern
// does: the page reads the dropped File's bytes and the chat's attachment store writes them once,
// into a pending file in its own folder that is renamed into place. Main has already checked
// which dropped paths are such files (`fromDroppedFiles`); everything else keeps its path.

import type { NativeFileDropCopyFailureReason } from '../../../shared/native-file-drop'
import type {
  DroppedFileBytesSlot,
  PreparedDroppedPaths
} from '../../../shared/native-file-drop-preparation'

// Why one at a time per window: a queued drop holds only File references, never a second payload.
let byteIntakeTail: Promise<unknown> = Promise.resolve()

/** Stores each file main asked for and puts its path in its place; failures join the drop's. */
export function takeDroppedFileBytes(
  prepared: PreparedDroppedPaths,
  files: readonly File[]
): Promise<PreparedDroppedPaths> {
  const slots = prepared.fromDroppedFiles ?? []
  if (slots.length === 0) {
    return Promise.resolve(prepared)
  }
  const run = byteIntakeTail.then(() => storeSlots(prepared, slots, files))
  byteIntakeTail = run.catch(() => undefined)
  return run
}

type StoredFile = { path: string } | { reason: NativeFileDropCopyFailureReason }

async function storeSlots(
  prepared: PreparedDroppedPaths,
  slots: readonly DroppedFileBytesSlot[],
  files: readonly File[]
): Promise<PreparedDroppedPaths> {
  const stored = new Map<number, StoredFile>()
  for (const slot of slots) {
    if (!stored.has(slot.sourceIndex)) {
      stored.set(slot.sourceIndex, await storeFileBytes(files[slot.sourceIndex], slot.byteLength))
    }
  }
  const slotAt = new Map(slots.map((slot) => [slot.position, slot]))
  const paths: string[] = []
  let nextPath = 0
  for (let position = 0; position < prepared.paths.length + slots.length; position += 1) {
    const slot = slotAt.get(position)
    const outcome: StoredFile | undefined = slot
      ? stored.get(slot.sourceIndex)
      : { path: prepared.paths[nextPath++] }
    if (outcome && 'path' in outcome) {
      paths.push(outcome.path)
    }
  }
  const lost = [...stored.values()].flatMap((outcome) =>
    'reason' in outcome ? [outcome.reason] : []
  )
  if (lost.length === 0) {
    return { paths, failures: prepared.failures }
  }
  const commonReason = lost.every((reason) => reason === lost[0]) ? lost[0] : undefined
  return {
    paths,
    failures: [
      ...prepared.failures,
      {
        target: 'rejected',
        reason: 'temp-copy-failed',
        pathCount: lost.length,
        byteLength: 0,
        ...(commonReason ? { commonReason } : {})
      }
    ]
  }
}

async function storeFileBytes(file: File | undefined, byteLength: number): Promise<StoredFile> {
  if (!file) {
    return { reason: 'missing' }
  }
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch (error) {
    // Why: the browser refuses a File whose file was removed or changed after the drop.
    const missing = error instanceof DOMException && error.name === 'NotFoundError'
    return { reason: missing ? 'missing' : 'changed' }
  }
  if (bytes.byteLength !== byteLength) {
    return { reason: 'changed' }
  }
  try {
    const result = await window.api.fs.storeDroppedFileBytes({ name: file.name, bytes })
    const path = result.paths[0]
    return path ? { path } : { reason: result.failures[0]?.commonReason ?? 'copy-failed' }
  } catch {
    return { reason: 'copy-failed' }
  }
}
