import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  nativeSkillInstallFilesystem,
  type SkillDirectoryEntry,
  type SkillFilesystemEntryKind
} from '../skill-install-filesystem'
import { createNativeSkillAlias } from '../skill-placement-reconciliation'

export type BundledSkillPathStat = { kind: SkillFilesystemEntryKind; mtimeMs: number | null }

/**
 * Everything the bundled installer does to a host's disk, so a WSL guest or a remote host can
 * supply its own. Reads never throw for a missing path; writes throw on any failure.
 */
export type BundledSkillFilesystem = {
  /** Whether this host can make a directory link; decided once, so `plan` never promises one it can't. */
  readonly supportsLinks: boolean
  /** `lstat` semantics; null when the path cannot be read at all. */
  stat(path: string): Promise<BundledSkillPathStat | null>
  readLink(path: string): Promise<string | null>
  realpath(path: string): Promise<string | null>
  /** `[]` for a missing directory, null when it cannot be listed. */
  listEntries(directory: string): Promise<SkillDirectoryEntry[] | null>
  readFile(path: string): Promise<Buffer | null>
  /** Whether the nearest existing ancestor of `directory` accepts new entries. */
  canWrite(directory: string): Promise<boolean>
  /** Creates `path` (and missing parents) holding exactly `files`; dirs 0755, files 0644. */
  writeFolder(path: string, files: readonly { path: string; text: string }[]): Promise<void>
  ensureDirectory(path: string): Promise<void>
  rename(source: string, target: string): Promise<void>
  remove(path: string): Promise<void>
  createLink(target: string, linkPath: string): Promise<void>
}

function kindOf(stats: Awaited<ReturnType<typeof lstat>>): SkillFilesystemEntryKind {
  if (stats.isSymbolicLink()) {
    return 'symlink'
  }
  if (stats.isDirectory()) {
    return 'directory'
  }
  return stats.isFile() ? 'file' : 'other'
}

export function filesystemErrorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'error'
}

function isMissing(error: unknown): boolean {
  const code = filesystemErrorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export const nativeBundledSkillFilesystem: BundledSkillFilesystem = {
  supportsLinks: true,
  stat: async (path) => {
    try {
      const stats = await lstat(path)
      return { kind: kindOf(stats), mtimeMs: stats.mtimeMs }
    } catch (error) {
      return isMissing(error) ? { kind: 'missing', mtimeMs: null } : null
    }
  },
  readLink: (path) => readlink(path).catch(() => null),
  realpath: (path) => realpath(path).catch(() => null),
  listEntries: async (directory) => {
    const listing = await nativeSkillInstallFilesystem.listEntries?.([directory]).catch(() => null)
    return listing?.get(directory) ?? null
  },
  readFile: (path) => readFile(path).catch(() => null),
  canWrite: async (directory) => {
    for (let current = directory; ; current = dirname(current)) {
      const writable = await access(current, constants.W_OK).then(
        () => true,
        (error: unknown) => (isMissing(error) ? null : false)
      )
      if (writable !== null || dirname(current) === current) {
        return writable ?? false
      }
    }
  },
  writeFolder: async (path, files) => {
    await mkdir(dirname(path), { recursive: true })
    // Why explicit modes: the cloud installer stages 0700, which other agents' users can't read.
    await mkdir(path, { mode: 0o755 })
    for (const file of files) {
      await mkdir(dirname(join(path, file.path)), { recursive: true, mode: 0o755 })
      await writeFile(join(path, file.path), file.text, { mode: 0o644, flag: 'wx' })
    }
  },
  ensureDirectory: async (path) => {
    await mkdir(path, { recursive: true })
  },
  rename: nativeSkillInstallFilesystem.rename,
  remove: nativeSkillInstallFilesystem.remove,
  createLink: createNativeSkillAlias
}
