/**
 * A slept pane's scrollback lives only in the daemon's checkpoint, never in a renderer snapshot, so
 * a WSL move reads it right after its Sleep and carries it on the snapshot channel under the pane's
 * own ref. Each buffer is spooled to a file, so only hashes and sizes stay in memory.
 */
import { createHash } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES } from '../../../shared/orcad-migration/orcad-migration-scrollback'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../../../shared/terminal-scrollback-limits'
import type { OrcadMigrationSnapshotSource } from '../../ssh/orcad-migration-snapshot-coordinator'
import {
  decodeFromFirstUtf8Boundary,
  makeTerminalScrollbackSnapshotRef
} from '../../terminal-scrollback-snapshots'
import type { WslMoveDriverDeps } from './wsl-move-driver-ports'
import type { ColdRestoreReader, WslMoveRestoreHintPane } from './wsl-move-restore-hints'

export type WslMoveSleptBuffer = { path: string; sha256: string; byteLength: number }

export type WslMoveSleptScrollback = {
  /** Keyed `tabId:leafId`. */
  buffers: ReadonlyMap<string, WslMoveSleptBuffer>
  /** User-facing: panes whose latest history can't be read. The move refuses rather than drop it. */
  problems: readonly string[]
  /** Removes the spooled files; the move calls it whatever its outcome. */
  dispose: () => void
}

const SPOOL_DIR = 'wsl-move-slept-scrollback'

export function emptyWslMoveSleptScrollback(): WslMoveSleptScrollback {
  return { buffers: new Map(), problems: [], dispose: () => {} }
}

/** Never throws: an unreadable reader is a problem the move reports, not a crash. */
export async function readSleptScrollback(
  deps: Pick<WslMoveDriverDeps, 'sleptScrollback'>,
  panes: readonly WslMoveRestoreHintPane[],
  distro: string,
  migrationId: string
): Promise<WslMoveSleptScrollback> {
  if (!deps.sleptScrollback) {
    return emptyWslMoveSleptScrollback()
  }
  return deps.sleptScrollback(panes, distro, migrationId).catch((error: unknown) => {
    console.warn('[wsl-move] Slept terminal history unreadable:', error)
    return {
      ...emptyWslMoveSleptScrollback(),
      problems: ['saved terminal history Orca could not read']
    }
  })
}

/** For the export: a slept pane's buffer, read from its spool file only while it is hashed. */
export function sleptScrollbackReader(
  slept: WslMoveSleptScrollback
): ((tabId: string, leafId: string) => Buffer | null) | undefined {
  if (slept.buffers.size === 0) {
    return undefined
  }
  return (tabId, leafId) => {
    const entry = slept.buffers.get(`${tabId}:${leafId}`)
    return entry ? readFileSync(entry.path) : null
  }
}

/**
 * Production reader: each pane's checkpoint as cold restore would replay it (scrollback, then the
 * screen), kept to the newest bytes one stored snapshot holds. Sleep ends a session cleanly, which
 * is exactly why its clean end is not a reason to skip the checkpoint here.
 */
export async function readWslMoveSleptScrollbackFromHistory(
  reader: ColdRestoreReader,
  panes: readonly WslMoveRestoreHintPane[],
  distro: string,
  spoolRoot: string
): Promise<WslMoveSleptScrollback> {
  const buffers = new Map<string, WslMoveSleptBuffer>()
  const problems: string[] = []
  const dispose = (): void => rmSync(spoolRoot, { recursive: true, force: true })
  try {
    mkdirSync(spoolRoot, { recursive: true, mode: 0o700 })
    for (const [index, pane] of panes.entries()) {
      const leaf = parsePaneKey(pane.paneKey)
      if (!leaf) {
        continue
      }
      const detection = await reader
        .detectColdRestoreState(pane.sessionId, { ignoreCleanEnd: true, wslDistro: distro })
        .catch(() => ({ status: 'unreadable' as const, sessionId: pane.sessionId }))
      if (detection.status === 'none') {
        continue
      }
      // A checkpoint behind an unreadable log is older than the pane: moving it would lose the rest.
      if (detection.status === 'unreadable' || detection.hasUnreadableRecovery) {
        problems.push(`saved terminal history Orca could not fully read for tab ${leaf.tabId}`)
        continue
      }
      const { scrollbackAnsi, snapshotAnsi } = detection.restoreInfo
      const bytes = capped(Buffer.from(`${scrollbackAnsi}${snapshotAnsi}`, 'utf8'))
      if (bytes.length === 0) {
        continue
      }
      const path = join(spoolRoot, `${index}.bin`)
      writeFileSync(path, bytes, { mode: 0o600 })
      buffers.set(`${leaf.tabId}:${leaf.leafId}`, {
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.length
      })
    }
  } catch (error) {
    dispose()
    throw error
  }
  return { buffers, problems, dispose }
}

export function wslMoveSleptSpoolRoot(userDataPath: string, migrationId: string): string {
  return join(userDataPath, SPOOL_DIR, migrationId)
}

function capped(bytes: Buffer): Buffer {
  return bytes.length > TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT
    ? Buffer.from(
        decodeFromFirstUtf8Boundary(bytes.subarray(-TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT)),
        'utf8'
      )
    : bytes
}

/** The store's snapshot reader, answering a slept pane's ref from its spool file. */
export function withSleptSnapshots(
  source: OrcadMigrationSnapshotSource,
  slept: WslMoveSleptScrollback
): OrcadMigrationSnapshotSource {
  if (slept.buffers.size === 0) {
    return source
  }
  const byRef = new Map<string, WslMoveSleptBuffer>()
  for (const [key, entry] of slept.buffers) {
    const split = key.lastIndexOf(':')
    byRef.set(makeTerminalScrollbackSnapshotRef(key.slice(0, split), key.slice(split + 1)), entry)
  }
  return {
    readOrcadMigrationSourceSnapshotChunk: (manifest, ref, offset) => {
      const descriptor = manifest.payload.dormantState?.terminalScrollbackSnapshots?.find(
        (entry) => entry.ref === ref
      )
      const entry = byRef.get(ref)
      // A ref the manifest signed from the store (not this spool) is the store's to serve.
      if (!descriptor || !entry || entry.sha256 !== descriptor.sha256) {
        return source.readOrcadMigrationSourceSnapshotChunk(manifest, ref, offset)
      }
      const length = Math.max(
        0,
        Math.min(ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES, entry.byteLength - offset)
      )
      const chunk = Buffer.alloc(length)
      const fd = openSync(entry.path, 'r')
      try {
        readSync(fd, chunk, 0, length, offset)
      } finally {
        closeSync(fd)
      }
      return {
        bytesBase64: chunk.toString('base64'),
        totalBytes: entry.byteLength,
        eof: offset + length >= entry.byteLength
      }
    }
  }
}
