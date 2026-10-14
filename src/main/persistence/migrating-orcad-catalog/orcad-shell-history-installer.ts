/**
 * Destination half of the `shell-history` blob: a pre-commit check that each file names a worktree
 * of the migrated catalog, and the post-commit install into this host's history root at the path
 * a zsh/bash pane in that worktree gets as HISTFILE (`<root>/<hash>/<shell>_history`).
 */
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ORCAD_MIGRATION_BLOB_KIND_CONTRACTS } from '../../../shared/orcad-migration-blob-transfer'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import { projectGroupIdFromRepoId } from '../../../shared/folder-workspace-worktree'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { splitWorktreeId } from '../../../shared/worktree/id'
import {
  durableWriteTempPath,
  syncDirectoryDurablySync,
  writeFileDurableSync
} from '../../durable-file-write'
import { readHistoryMeta } from '../../terminal-history'
import {
  getOrcadMigrationReceivedBlobPath,
  listOrcadMigrationReceivedBlobNames
} from './orcad-migration-blob-staging'
import {
  ORCAD_MIGRATION_SHELL_HISTORY_HEADER_SCAN_BYTES,
  parseOrcadMigrationShellHistoryHeader,
  parseOrcadMigrationShellHistoryKey,
  shellHistoryFileName,
  type OrcadMigrationShellHistoryShell
} from './orcad-migration-shell-history-format'
import type { OrcadMigrationRequestIdentity } from './orcad-migration-staged-file'

type ShellHistoryCatalog = Pick<
  OrcadMigrationManifest['payload'],
  'repositories' | 'projectGroups' | 'folderWorkspaces'
>

/** Throws unless the staged file is a well-formed history for a worktree this catalog moves. */
export function assertOrcadMigrationShellHistoryValid(
  key: string,
  path: string,
  catalog: ShellHistoryCatalog
): void {
  const { worktreeId } = parseOrcadMigrationShellHistoryHeader(
    key,
    readHead(path, ORCAD_MIGRATION_SHELL_HISTORY_HEADER_SCAN_BYTES),
    statSync(path).size
  )
  if (!catalogOwnsWorktree(catalog, worktreeId)) {
    throw new Error('orcad_migration_shell_history_worktree_not_migrated')
  }
}

export type OrcadShellHistoryInstall = {
  migration: OrcadMigrationRequestIdentity
  root: string
  /** This host's `getHistoryRoot()`. */
  historyRoot: string
  /** The shell a new pane on this host runs, when it is one whose history moves. */
  loginShell: () => OrcadMigrationShellHistoryShell | null
  now: number
}

/**
 * Installs every received history file, then deletes it. Already installed (the destination file
 * starts with the moved bytes) only deletes. A write failure keeps the blob for the next retry and
 * is rethrown once the others had their turn.
 */
export function installOrcadMigrationShellHistory(install: OrcadShellHistoryInstall): void {
  let firstError: unknown = null
  for (const key of listOrcadMigrationReceivedBlobNames(
    install.root,
    install.migration,
    'shell-history'
  )) {
    if (!ORCAD_MIGRATION_BLOB_KIND_CONTRACTS['shell-history'].key.test(key)) {
      continue
    }
    try {
      installOne(install, key)
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError !== null) {
    throw firstError
  }
}

type ReceivedShellHistory = {
  worktreeId: string
  worktreeHash: string
  fileName: string
  history: Buffer
}

function installOne(install: OrcadShellHistoryInstall, key: string): void {
  const path = getOrcadMigrationReceivedBlobPath(install.root, install.migration, {
    blobKind: 'shell-history',
    key
  })
  const bytes = readFileSync(path)
  let moved: ReceivedShellHistory
  try {
    const header = parseOrcadMigrationShellHistoryHeader(key, bytes, bytes.length)
    const { worktreeHash, shell } = parseOrcadMigrationShellHistoryKey(key)
    moved = {
      worktreeId: header.worktreeId,
      worktreeHash,
      fileName: shellHistoryFileName(header.loginShell ? (install.loginShell() ?? shell) : shell),
      history: bytes.subarray(header.byteLength)
    }
  } catch (error) {
    // The pre-commit check passed these bytes, so only a damaged file lands here.
    console.error(`[orcad-migration] dropped unreadable shell history ${key}:`, error)
    removeReceived(path)
    return
  }
  const directory = join(install.historyRoot, moved.worktreeHash)
  // Owner-only, like the history directories terminal-history.ts creates.
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeHistoryFile(join(directory, moved.fileName), moved.history)
  writeMeta(directory, moved.worktreeId, install.now)
  removeReceived(path)
}

/**
 * The host normally has no history for a worktree that just arrived. If it has some, nothing is
 * overwritten: the moved history goes first (it is older) and the host's own lines follow, so the
 * newest commands stay at the end where shells read them back from.
 */
function writeHistoryFile(path: string, moved: Buffer): void {
  const existing = readExisting(path)
  if (existing?.subarray(0, moved.length).equals(moved)) {
    return
  }
  // Keeps the last moved command and the host's first one on separate lines.
  const separator = existing?.length && moved.at(-1) !== 0x0a ? '\n' : ''
  const content = existing ? Buffer.concat([moved, Buffer.from(separator), existing]) : moved
  writeFileDurableSync(durableWriteTempPath(path), path, content, 0o600)
}

// GC prunes a history directory by its meta.json worktree id, so it must name the host's id.
function writeMeta(directory: string, worktreeId: string, now: number): void {
  const existing = readHistoryMeta(directory)
  if (existing?.worktreeId === worktreeId) {
    return
  }
  const path = join(directory, 'meta.json')
  const meta = {
    ...existing,
    worktreeId,
    createdAt: existing?.createdAt ?? new Date(now).toISOString()
  }
  writeFileDurableSync(durableWriteTempPath(path), path, JSON.stringify(meta), 0o600)
}

function readExisting(path: string): Buffer | null {
  try {
    return readFileSync(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function removeReceived(path: string): void {
  rmSync(path, { force: true })
  syncDirectoryDurablySync(dirname(path))
}

function readHead(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes)
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

function catalogOwnsWorktree(catalog: ShellHistoryCatalog, worktreeId: string): boolean {
  if (
    catalog.folderWorkspaces.some((workspace) => folderWorkspaceKey(workspace.id) === worktreeId)
  ) {
    return true
  }
  const parsed = splitWorktreeId(worktreeId)
  if (!parsed?.repoId || !parsed.worktreePath) {
    return false
  }
  const projectGroupId = projectGroupIdFromRepoId(parsed.repoId)
  return projectGroupId
    ? catalog.projectGroups.some((group) => group.id === projectGroupId)
    : catalog.repositories.some((repo) => repo.id === parsed.repoId)
}
