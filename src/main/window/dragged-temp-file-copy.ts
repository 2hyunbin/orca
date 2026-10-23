import { constants, createWriteStream, type Stats } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { NativeFileDropCopyFailureReason } from '../../shared/native-file-drop'
import {
  formatByteCeiling,
  REMOTE_IMPORT_MAX_FILE_BYTES,
  REMOTE_IMPORT_MAX_TOTAL_BYTES
} from '../ipc/runtime-import-limits'
import {
  hasDragTempMarker,
  isPathWithin,
  mayNeedDragTempCopy,
  relativeSegments
} from './drag-temp-path'
import { ensureOwnedTempStagingRoot, getOwnedTempStagingRoot } from './owned-temp-staging-root'

// Why: macOS screenshot thumbnails live in `$TMPDIR/TemporaryItems/NSIRD_*`,
// which only processes attributed to Orca main may open. The detached PTY
// daemon is not, so agents in local terminals get EPERM on the original path.

const COPY_DIR_PREFIX = 'orca-drop-'
const DRAG_TEMP_COPY_ROOT_NAME = 'orca-drops'
// Why no expiry: a copy may be what a terminal agent, a draft or a sent message still names, and
// nothing tells which; a local chat's drop is written straight into its chat store instead.
const COPY_HIGH_WATER_MARK = 1024 * 1024

export type DragTempCopyEnvironment = {
  platform: NodeJS.Platform
  /** macOS per-user temp dir: where drag providers put their files. */
  sourceTempRoot: string
  /** Orca-owned directory that holds one `orca-drop-*` directory per copy. */
  copyRoot: string
}

export type DragTempCopyItemResult =
  | {
      sourcePath: string
      status: 'imported'
      destPath: string
      byteLength?: number
      directory?: string
    }
  /** Checked and held open, unread: a local chat writes it straight into its store. */
  | { sourcePath: string; status: 'opened'; source: CheckedDragTempSource }
  /** Left as the original path, which only main's children can open. */
  | { sourcePath: string; status: 'uncopied'; reason: 'too-large' | 'storage-full' }
  | { sourcePath: string; status: 'failed'; reason: NativeFileDropCopyFailureReason }

/** A checked drag-temp file: the handle reads the dropped bytes even after the provider removes
 *  the path, and every write compares it against the snapshot taken when it was opened. */
export type CheckedDragTempSource = {
  sourcePath: string
  name: string
  handle: FileHandle
  snapshot: Stats
  size: number
}

export class DragTempCopyBatch {
  readonly completed = new Map<string, DragTempCopyItemResult>()
  readonly directories = new Set<string>()
  readonly opened = new Set<CheckedDragTempSource>()
  /** Files at or under this size are held open instead of copied; -1 for none. */
  constructor(readonly openMaxBytes = -1) {}
}

export function getDragTempCopyRoot(appTempRoot: string): string {
  return getOwnedTempStagingRoot(appTempRoot, DRAG_TEMP_COPY_ROOT_NAME)
}

/**
 * Copy every drag-temp path in a drop into Orca-owned storage, sequentially,
 * within the per-drop byte budget. Other paths pass through unchanged.
 */
export async function materializeDragTempPaths(
  paths: readonly string[],
  env: DragTempCopyEnvironment,
  signal?: AbortSignal,
  batch = new DragTempCopyBatch()
): Promise<DragTempCopyItemResult[]> {
  const { completed } = batch
  // Why per drop: copies are never swept, so earlier drops must not refuse later ones.
  let remainingBytes = env.platform === 'darwin' ? REMOTE_IMPORT_MAX_TOTAL_BYTES : 0
  try {
    for (const sourcePath of paths) {
      signal?.throwIfAborted()
      if (completed.has(sourcePath)) {
        continue
      }
      const capture = await materializeDragTempPath(sourcePath, remainingBytes, env, signal, batch)
      remainingBytes -= capture.copiedBytes
      completed.set(sourcePath, capture.result)
    }
    signal?.throwIfAborted()
    return paths.map((path) => completed.get(path)!)
  } catch (error) {
    completed.clear()
    await releaseDragTempBatch(batch)
    throw error
  }
}

/** Closes every source still held open and removes the copies this batch created. */
export async function releaseDragTempBatch(batch: DragTempCopyBatch): Promise<void> {
  for (const source of batch.opened) {
    await closeDragTempSource(batch, source)
  }
  await removeCreatedDragTempCopies(batch.directories)
}

export async function closeDragTempSource(
  batch: DragTempCopyBatch,
  source: CheckedDragTempSource
): Promise<void> {
  if (batch.opened.delete(source)) {
    await source.handle.close().catch(() => undefined)
  }
}

export async function removeCreatedDragTempCopies(directories: Iterable<string>): Promise<void> {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Streams the checked source into `destPath` from offset 0, then proves the bytes are the ones
 *  opened: written size and the handle's stat must still match the open-time snapshot. */
export async function writeCheckedDragTempSource(
  source: CheckedDragTempSource,
  destPath: string,
  signal?: AbortSignal
): Promise<void> {
  // Reading bytes from the checked handle copies no xattrs, unlike cp, ditto or clonefile.
  await (source.size === 0
    ? writeFile(destPath, '', { flag: 'wx', mode: 0o600 })
    : pipeline(
        readCheckedDragTempSource(source),
        createWriteStream(destPath, {
          flags: 'wx',
          mode: 0o600,
          highWaterMark: COPY_HIGH_WATER_MARK
        }),
        { signal }
      ))
  const written = await lstat(destPath)
  if (
    written.size !== source.size ||
    !isSameSnapshot(await source.handle.stat(), source.snapshot)
  ) {
    throw new DropCopyError('changed')
  }
}

// The pipeline owns the iterator, while the batch keeps the handle for a fallback write.
async function* readCheckedDragTempSource(source: CheckedDragTempSource): AsyncGenerator<Buffer> {
  for (let position = 0; position < source.size;) {
    const buffer = Buffer.allocUnsafe(Math.min(COPY_HIGH_WATER_MARK, source.size - position))
    const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) {
      return
    }
    position += bytesRead
    yield buffer.subarray(0, bytesRead)
  }
}

export function isDragTempSourceChanged(error: unknown): boolean {
  return error instanceof DropCopyError && error.reason === 'changed'
}

/** A private 0600 copy in Orca's temp storage, for consumers that need a path. */
export async function copyCheckedDragTempSource(
  source: CheckedDragTempSource,
  env: DragTempCopyEnvironment,
  batch: DragTempCopyBatch,
  signal?: AbortSignal
): Promise<DragTempCopyItemResult> {
  let directory: string | undefined
  try {
    directory = await createCopyDirectory(env.copyRoot, batch)
    signal?.throwIfAborted()
    const destPath = join(directory, source.name)
    await writeCheckedDragTempSource(source, destPath, signal)
    // Why: a caller that gave up mid-copy never hands this path out; don't retain it.
    signal?.throwIfAborted()
    console.debug('[drop] copied a drag-temp file into Orca storage', { bytes: source.size })
    return {
      sourcePath: source.sourcePath,
      status: 'imported',
      destPath,
      byteLength: source.size,
      directory
    }
  } catch (error) {
    if (directory) {
      // Why: cleanup must not hide the original failure or stop later items.
      batch.directories.delete(directory)
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
    if (signal?.aborted) {
      throw error
    }
    return classifyFailure(source.sourcePath, error)
  }
}

export async function materializeDragTempPath(
  sourcePath: string,
  remainingBytes: number,
  env: DragTempCopyEnvironment,
  signal?: AbortSignal,
  batch = new DragTempCopyBatch()
): Promise<{ result: DragTempCopyItemResult; copiedBytes: number }> {
  const passThrough = { result: imported(sourcePath, sourcePath), copiedBytes: 0 }
  if (!mayNeedDragTempCopy(sourcePath, env.platform)) {
    return passThrough
  }
  try {
    let inspected: Stats
    try {
      inspected = await lstat(sourcePath)
    } catch (error) {
      // A missing lookalike outside `$TMPDIR` is still an ordinary path.
      if (
        errorCode(error) === 'ENOENT' &&
        !isPathWithin(resolve(env.sourceTempRoot), resolve(sourcePath))
      ) {
        return passThrough
      }
      throw error
    }
    if (!inspected.isFile()) {
      // Why: directories and symlinks keep today's reference-in-place behaviour.
      return passThrough
    }
    const canonicalSource = await realpath(sourcePath)
    const canonicalTempRoot = await realpath(env.sourceTempRoot)
    if (!hasDragTempMarker(relativeSegments(canonicalTempRoot, canonicalSource))) {
      return passThrough
    }

    const handle = await open(canonicalSource, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let heldOpen = false
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || !isSameSnapshot(opened, inspected)) {
        throw new DropCopyError('changed')
      }
      const size = opened.size
      if (size > REMOTE_IMPORT_MAX_FILE_BYTES || size > remainingBytes) {
        // Why: targets read by main can still use the original; the relay decides.
        console.warn('[drop] leaving a drag-temp file uncopied: over the copy budget', {
          bytes: formatByteCeiling(size),
          remaining: formatByteCeiling(Math.max(remainingBytes, 0))
        })
        const reason = size > REMOTE_IMPORT_MAX_FILE_BYTES ? 'too-large' : 'storage-full'
        return { result: { sourcePath, status: 'uncopied', reason }, copiedBytes: 0 }
      }
      signal?.throwIfAborted()
      const source: CheckedDragTempSource = {
        sourcePath,
        name: basename(canonicalSource),
        handle,
        snapshot: opened,
        size
      }
      if (size <= batch.openMaxBytes) {
        // Why unread: the chat store writes it once, straight from this handle.
        heldOpen = true
        batch.opened.add(source)
        return { result: { sourcePath, status: 'opened', source }, copiedBytes: size }
      }
      const result = await copyCheckedDragTempSource(source, env, batch, signal)
      return { result, copiedBytes: result.status === 'imported' ? size : 0 }
    } finally {
      if (!heldOpen) {
        await handle.close()
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    return { result: classifyFailure(sourcePath, error), copiedBytes: 0 }
  }
}

async function createCopyDirectory(copyRoot: string, batch: DragTempCopyBatch): Promise<string> {
  try {
    if (!(await ensureOwnedTempStagingRoot(copyRoot))) {
      throw new DropCopyError('storage-not-private')
    }
    const directory = await mkdtemp(join(copyRoot, COPY_DIR_PREFIX))
    batch.directories.add(directory)
    return directory
  } catch (error) {
    if (error instanceof DropCopyError) {
      throw error
    }
    // Why: a storage fault must not read as a missing or unreadable dropped file.
    console.warn('[drop] could not create drop storage', { code: errorCode(error) })
    throw new DropCopyError(isOutOfSpace(errorCode(error)) ? 'out-of-space' : 'storage-unavailable')
  }
}

/** Same inode, size and mtime, where the filesystem reports an inode. */
function isSameSnapshot(a: Stats, b: Stats): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    (a.ino === 0 || b.ino === 0 || a.ino === b.ino) &&
    (a.dev === 0 || b.dev === 0 || a.dev === b.dev)
  )
}

function imported(sourcePath: string, destPath: string): DragTempCopyItemResult {
  return { sourcePath, status: 'imported', destPath }
}

class DropCopyError extends Error {
  constructor(readonly reason: NativeFileDropCopyFailureReason) {
    super(reason)
  }
}

function classifyFailure(sourcePath: string, error: unknown): DragTempCopyItemResult {
  return { sourcePath, status: 'failed', reason: failureReason(error) }
}

function isOutOfSpace(code: string | undefined): boolean {
  return code === 'ENOSPC' || code === 'EDQUOT'
}

function failureReason(error: unknown): NativeFileDropCopyFailureReason {
  if (error instanceof DropCopyError) {
    return error.reason
  }
  const code = errorCode(error)
  if (code === 'ENOENT') {
    return 'missing'
  }
  if (code === 'EPERM' || code === 'EACCES') {
    return 'permission-denied'
  }
  console.warn('[drop] could not copy a drag-temp file', { code })
  return isOutOfSpace(code) ? 'out-of-space' : 'copy-failed'
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return undefined
}
