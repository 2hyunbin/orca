import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  access,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  nativeSkillInstallFilesystem,
  type SkillDirectoryEntry,
  type SkillFilesystemEntryKind
} from '../skill-install-filesystem'
import { createNativeSkillAlias } from '../skill-placement-reconciliation'

/** One path as `plan` and `execute` need it, read in one go so a guest host answers a batch at once. */
export type BundledSkillPathObservation = {
  /** `lstat` semantics: a link is `symlink` whatever it points at. */
  kind: SkillFilesystemEntryKind
  mtimeMs: number | null
  /** A link's raw target; null when it can't be read. */
  linkTarget?: string | null
  /** Where a link resolves; null when broken. */
  linkRealPath?: string | null
  /** A directory's entries; null when it can't be listed. */
  entries?: SkillDirectoryEntry[] | null
  /** A directory's `SKILL.md` bytes when that entry is a plain file; null when unreadable. */
  skillFile?: Buffer | null
}

export type BundledSkillFilesystem = {
  /** Whether this host can make a directory link; decided once, so `plan` never promises one it can't. */
  readonly supportsLinks: boolean
  /** Keyed by the given paths; a null value is a path that can't be read at all. */
  observe(paths: readonly string[]): Promise<Map<string, BundledSkillPathObservation | null>>
  realpath(path: string): Promise<string | null>
  /** Whether the nearest existing ancestor of `directory` accepts new entries. */
  canWrite(directory: string): Promise<boolean>
  /** Creates `path` (and missing parents) holding exactly `files`; dirs 0755, files 0644. */
  writeFolder(path: string, files: readonly { path: string; text: string }[]): Promise<void>
  ensureDirectory(path: string): Promise<void>
  rename(source: string, target: string): Promise<void>
  /** Rename into backups, which may sit on another filesystem: copy, verify, then remove. */
  moveToBackup(source: string, target: string): Promise<void>
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

/** Every entry's relative path, kind and content (or link target), in a fixed order. */
async function treeSignature(path: string): Promise<string> {
  const hash = createHash('sha256')
  const visit = async (current: string, relative: string): Promise<void> => {
    const stats = await lstat(current)
    hash.update(`${relative}\0${kindOf(stats)}\0`)
    if (stats.isSymbolicLink()) {
      hash.update(await readlink(current))
    } else if (stats.isFile()) {
      hash.update(await readFile(current))
    } else if (stats.isDirectory()) {
      for (const name of (await readdir(current)).sort()) {
        await visit(join(current, name), `${relative}/${name}`)
      }
    }
    hash.update('\0')
  }
  await visit(path, '.')
  return hash.digest('hex')
}

async function observeNative(path: string): Promise<BundledSkillPathObservation | null> {
  let stats: Awaited<ReturnType<typeof lstat>>
  try {
    stats = await lstat(path)
  } catch (error) {
    return isMissing(error) ? { kind: 'missing', mtimeMs: null } : null
  }
  const kind = kindOf(stats)
  if (kind === 'symlink') {
    return {
      kind,
      mtimeMs: stats.mtimeMs,
      linkTarget: await readlink(path).catch(() => null),
      linkRealPath: await realpath(path).catch(() => null)
    }
  }
  if (kind !== 'directory') {
    return { kind, mtimeMs: stats.mtimeMs }
  }
  const listing = await nativeSkillInstallFilesystem.listEntries?.([path]).catch(() => null)
  const entries = listing?.get(path) ?? null
  const hasSkillFile = entries?.some((entry) => entry.name === 'SKILL.md' && entry.kind === 'file')
  return {
    kind,
    mtimeMs: stats.mtimeMs,
    entries,
    ...(hasSkillFile ? { skillFile: await readFile(join(path, 'SKILL.md')).catch(() => null) } : {})
  }
}

export async function moveAcrossFilesystems(
  source: string,
  target: string,
  rename: (source: string, target: string) => Promise<void> = nativeSkillInstallFilesystem.rename
): Promise<void> {
  try {
    await rename(source, target)
    return
  } catch (error) {
    if (filesystemErrorCode(error) !== 'EXDEV') {
      throw error
    }
  }
  await cp(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false
  })
  // The source is removed only once the copy provably holds the same bytes.
  if ((await treeSignature(source)) !== (await treeSignature(target))) {
    throw Object.assign(new Error(`bundled-skill-backup-mismatch: ${target}`), { code: 'EBACKUP' })
  }
  await rm(source, { recursive: true, force: true })
}

export const nativeBundledSkillFilesystem: BundledSkillFilesystem = {
  supportsLinks: true,
  observe: async (paths) =>
    new Map(
      await Promise.all(paths.map(async (path) => [path, await observeNative(path)] as const))
    ),
  realpath: (path) => realpath(path).catch(() => null),
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
  moveToBackup: (source, target) => moveAcrossFilesystems(source, target),
  remove: nativeSkillInstallFilesystem.remove,
  createLink: createNativeSkillAlias
}
