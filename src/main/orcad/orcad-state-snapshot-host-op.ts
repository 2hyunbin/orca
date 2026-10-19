/**
 * `orcad --orcad-state-snapshot capture <root> <snapshotDir> [<keep>...]`.
 *
 * The body of the POSIX pre-activation capture, run by the candidate slot's own Node inside the
 * client's shell lock and deadline (`serializedStateMutationCommand`). Same contract as the shell
 * script it replaces: last line `CAPTURED`, `EMPTY` or `FAILED`, a failure preceded by
 * `SNAPSHOT_FAILURE <reason>`, and a `state.tar` that older clients restore with `tar -x`.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import {
  ORCAD_SNAPSHOT_ARCHIVE_FILENAME,
  ORCAD_SNAPSHOT_CAPTURE_PREFIX,
  ORCAD_SNAPSHOT_FAILURE,
  ORCAD_SNAPSHOT_MEMBERS
} from '../managed-server/host-state/orcad-state-snapshot-members'

const FAILURE_REASON_MAX_CHARS = 400

export async function runOrcadStateSnapshotOp(argv: readonly string[]): Promise<string[]> {
  const [op, root, snapshotDir, ...keep] = argv
  if (op !== 'capture' || !root || !snapshotDir) {
    return failed(`Unknown state snapshot op: ${argv.join(' ')}`)
  }
  try {
    pruneCaptures(dirname(snapshotDir), new Set([basename(snapshotDir), ...keep]))
    return [await capture(root, snapshotDir)]
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
}

/** Every sibling `pre-*` dir but `keep`: what `orcadSnapshotSpaceCommand` counts as reclaimable. */
function pruneCaptures(snapshotsRoot: string, keep: ReadonlySet<string>): void {
  const entries = existsSync(snapshotsRoot)
    ? readdirSync(snapshotsRoot, { withFileTypes: true })
    : []
  for (const entry of entries) {
    const name = entry.name
    if (entry.isDirectory() && name.startsWith(ORCAD_SNAPSHOT_CAPTURE_PREFIX) && !keep.has(name)) {
      try {
        rmSync(join(snapshotsRoot, name), { recursive: true, force: true })
      } catch {
        // As the shell prune did: a stuck old capture must not block this one; the room check decides.
      }
    }
  }
}

async function capture(root: string, snapshotDir: string): Promise<string> {
  const members = ORCAD_SNAPSHOT_MEMBERS.filter((member) => lstatOrNull(join(root, member)))
  for (const member of members) {
    const link = firstLinkOrUnreadable(join(root, member))
    if (link) {
      throw new Error(`${member} holds a symbolic link or an entry Orca cannot read: ${link}`)
    }
  }
  if (members.length === 0) {
    return 'EMPTY'
  }
  process.umask(0o077)
  const archive = join(snapshotDir, ORCAD_SNAPSHOT_ARCHIVE_FILENAME)
  const partial = `${archive}.partial`
  try {
    mkdirSync(snapshotDir, { recursive: true })
    // Why tar and not a JS archive: older clients restore this file with the host's `tar -x`.
    const result = await runProcess({
      program: 'tar',
      args: ['-C', root, '-cf', partial, ...members],
      // The shell wrapper's deadline kills this whole process group.
      timeoutMs: null
    })
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `tar exited ${result.code ?? result.signal}`)
    }
    // A temp name then rename: a capture killed mid-tar never leaves a truncated archive.
    renameSync(partial, archive)
  } catch (error) {
    rmSync(partial, { force: true })
    try {
      rmdirSync(snapshotDir)
    } catch {
      // Not empty or already gone: either way nothing partial is left.
    }
    throw error
  }
  return 'CAPTURED'
}

function lstatOrNull(path: string): Stats | null {
  return lstatSync(path, { throwIfNoEntry: false }) ?? null
}

/** The first symlink under `path`, or the error that stopped the walk; null when clean. */
function firstLinkOrUnreadable(path: string): string | null {
  try {
    const stats = lstatSync(path)
    if (stats.isSymbolicLink()) {
      return path
    }
    if (!stats.isDirectory()) {
      return null
    }
    for (const name of readdirSync(path)) {
      const found = firstLinkOrUnreadable(join(path, name))
      if (found) {
        return found
      }
    }
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function failed(reason: string): string[] {
  const line = reason.replace(/\s+/g, ' ').slice(0, FAILURE_REASON_MAX_CHARS)
  return [`${ORCAD_SNAPSHOT_FAILURE} ${line}`, 'FAILED']
}

export async function runOrcadStateSnapshotOpAndExit(argv: readonly string[]): Promise<void> {
  const lines = await runOrcadStateSnapshotOp(argv)
  process.stdout.write(`${lines.join('\n')}\n`, () => process.exit(0))
}
