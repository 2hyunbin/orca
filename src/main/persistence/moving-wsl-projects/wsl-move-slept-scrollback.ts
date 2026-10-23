/**
 * A slept pane's scrollback lives only in the daemon's checkpoint, never in a renderer snapshot, so a
 * WSL move reads it after Sleep and carries it on the snapshot channel under the pane's own ref.
 */
import { createHash } from 'node:crypto'
import { ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES } from '../../../shared/orcad-migration/orcad-migration-scrollback'
import type { OrcadMigrationSnapshotSource } from '../../ssh/orcad-migration-snapshot-coordinator'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../../../shared/terminal-scrollback-limits'
import {
  decodeFromFirstUtf8Boundary,
  makeTerminalScrollbackSnapshotRef
} from '../../terminal-scrollback-snapshots'
import type { WslMoveDriverDeps } from './wsl-move-driver-ports'
import type { ColdRestoreReader, WslMoveRestoreHintPane } from './wsl-move-restore-hints'

/** Never throws: a pane whose checkpoint can't be read moves without its history, as before. */
export async function readSleptScrollback(
  deps: Pick<WslMoveDriverDeps, 'sleptScrollback'>,
  panes: readonly WslMoveRestoreHintPane[],
  distro: string
): Promise<ReadonlyMap<string, Buffer>> {
  if (!deps.sleptScrollback) {
    return new Map()
  }
  return deps.sleptScrollback(panes, distro).catch((error: unknown) => {
    console.warn('[wsl-move] Slept terminal history unreadable:', error)
    return new Map()
  })
}

/** The store's snapshot reader, answering a slept pane's ref from the buffer the manifest signed. */
export function withSleptSnapshots(
  source: OrcadMigrationSnapshotSource,
  slept: ReadonlyMap<string, Buffer>
): OrcadMigrationSnapshotSource {
  if (slept.size === 0) {
    return source
  }
  const byRef = new Map<string, { bytes: Buffer; sha256: string }>()
  for (const [key, bytes] of slept) {
    const split = key.lastIndexOf(':')
    byRef.set(makeTerminalScrollbackSnapshotRef(key.slice(0, split), key.slice(split + 1)), {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
  }
  return {
    readOrcadMigrationSourceSnapshotChunk: (manifest, ref, offset) => {
      const descriptor = manifest.payload.dormantState?.terminalScrollbackSnapshots?.find(
        (entry) => entry.ref === ref
      )
      const candidate = descriptor ? byRef.get(ref) : undefined
      // A leaf with its own renderer snapshot signed that one; the store serves it.
      const bytes = candidate?.sha256 === descriptor?.sha256 ? candidate?.bytes : undefined
      if (!bytes) {
        return source.readOrcadMigrationSourceSnapshotChunk(manifest, ref, offset)
      }
      const chunk = bytes.subarray(offset, offset + ORCAD_MIGRATION_SCROLLBACK_CHUNK_BYTES)
      return {
        bytesBase64: chunk.toString('base64'),
        totalBytes: bytes.length,
        eof: offset + chunk.length >= bytes.length
      }
    }
  }
}

/**
 * Production reader: each pane's checkpoint, as cold restore would replay it (scrollback, then the
 * screen), kept to the newest bytes one stored snapshot holds.
 */
export async function readWslMoveSleptScrollbackFromHistory(
  reader: ColdRestoreReader,
  panes: readonly WslMoveRestoreHintPane[],
  distro: string
): Promise<Map<string, Buffer>> {
  const buffers = new Map<string, Buffer>()
  for (const pane of panes) {
    const leaf = parsePaneKey(pane.paneKey)
    if (!leaf) {
      continue
    }
    // A sleep ends the session cleanly; its checkpoint is exactly what a cold restore would read.
    const detection = await reader
      .detectColdRestoreState(pane.sessionId, { ignoreCleanEnd: true, wslDistro: distro })
      .catch(() => null)
    if (detection?.status !== 'restored') {
      continue
    }
    const { scrollbackAnsi, snapshotAnsi } = detection.restoreInfo
    const bytes = Buffer.from(`${scrollbackAnsi}${snapshotAnsi}`, 'utf8')
    if (bytes.length > 0) {
      buffers.set(
        `${leaf.tabId}:${leaf.leafId}`,
        bytes.length > TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT
          ? Buffer.from(
              decodeFromFirstUtf8Boundary(bytes.subarray(-TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT)),
              'utf8'
            )
          : bytes
      )
    }
  }
  return buffers
}
