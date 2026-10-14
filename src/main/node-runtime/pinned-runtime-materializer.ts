/** Download, hash-verify and cache pinned runtimes, driven only by their pinned assets. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, link, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { getMainHttpClient, type MainHttpClient } from '../network/http-client'
import { downloadVerifiedArchive, extractRuntimeArchive } from './runtime-archive-download'
import { findOrcadCachePath } from './orcad-cache-path'
import { orcadNodeRuntimeExecutable } from '../../shared/orcad-artifacts'
import {
  pinnedNodeRuntimeAsset,
  nodeRuntimeExecutablePath,
  nodeRuntimeReleaseUrl,
  type NodeRuntimeTarget
} from '../../shared/node-runtime-pin'

export type PinnedRuntimeMaterializeOptions = {
  fetcher?: MainHttpClient['fetch']
  signal?: AbortSignal
}

export type PinnedRuntimeArchive = {
  /** Shown in errors, e.g. "Node". */
  label: string
  url: string
  archiveSha256: string
  /** The download's size limit; 200 MiB by default. */
  maxArchiveBytes?: number
}

export type PinnedRuntimeExecutable = PinnedRuntimeArchive & {
  executableSha256: string
  /** Archive-relative path of the executable. */
  member: string
  isWindows: boolean
  /** Where the verified executable is published; `attempt` > 0 names a repair beside it. */
  cachePath: (attempt: number) => string
}

export type PinnedRuntimeFolder = PinnedRuntimeArchive & {
  /** Archive-relative path and sha256 of every executable the folder must hold. */
  members: readonly { path: string; sha256: string }[]
}

const OWN_STAGING_PREFIX = `.download-${process.pid}-`

function archiveName(archive: PinnedRuntimeArchive): string {
  return basename(new URL(archive.url).pathname)
}

/** The pinned archive, downloaded once and kept by its own name; its hash is checked on every use. */
export async function materializeVerifiedRuntimeArchive(
  archive: PinnedRuntimeArchive,
  cacheDir: string,
  options: PinnedRuntimeMaterializeOptions
): Promise<string> {
  options.signal?.throwIfAborted()
  await mkdir(cacheDir, { recursive: true })
  const name = archiveName(archive)
  const cached = await findOrcadCachePath(
    (attempt) => join(cacheDir, `${attempt ? `repair-${attempt}-` : ''}${name}`),
    async (path) => (await fileSha256(path)) === archive.archiveSha256
  )
  if (cached.verified) {
    return cached.path
  }
  const temporaryDir = join(cacheDir, `.download-${process.pid}-${randomUUID()}`)
  await mkdir(temporaryDir, { recursive: true })
  try {
    const downloaded = join(temporaryDir, name)
    await downloadVerifiedArchive(
      archive,
      downloaded,
      options.fetcher ?? getMainHttpClient().fetch,
      options.signal
    )
    options.signal?.throwIfAborted()
    await publishVerified(
      downloaded,
      cached.path,
      archive.archiveSha256,
      `${archive.label} archive`
    )
    return cached.path
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }
}

export async function materializeCachedRuntimeExecutable(
  runtime: PinnedRuntimeExecutable,
  options: PinnedRuntimeMaterializeOptions
): Promise<string> {
  options.signal?.throwIfAborted()
  const cached = await findOrcadCachePath(
    runtime.cachePath,
    async (path) => (await fileSha256(path)) === runtime.executableSha256
  )
  const runtimePath = cached.path
  if (cached.verified) {
    if (!runtime.isWindows) {
      await chmod(runtimePath, 0o755)
    }
    return runtimePath
  }
  const runtimeDir = join(runtimePath, '..')
  await mkdir(runtimeDir, { recursive: true })
  const temporaryDir = join(runtimeDir, `.download-${process.pid}-${randomUUID()}`)
  await mkdir(temporaryDir, { recursive: true })
  try {
    const extractedDir = await downloadAndExtract(runtime, [runtime.member], temporaryDir, options)
    const executable = join(extractedDir, ...runtime.member.split('/'))
    await verifyFileSha256(executable, runtime.executableSha256, `${runtime.label} executable`)
    if (!runtime.isWindows) {
      await chmod(executable, 0o755)
    }
    options.signal?.throwIfAborted()
    await publishVerified(
      executable,
      runtimePath,
      runtime.executableSha256,
      `cached ${runtime.label} executable`
    )
    return runtimePath
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }
}

/** Publishes `folder` by one rename once every member verifies, so it only ever exists verified and
 *  a launch never hashes it again. */
export async function materializeVerifiedRuntimeFolder(
  runtime: PinnedRuntimeFolder,
  folder: string,
  options: PinnedRuntimeMaterializeOptions
): Promise<void> {
  options.signal?.throwIfAborted()
  const parent = dirname(folder)
  await mkdir(parent, { recursive: true })
  const temporaryDir = join(parent, `${OWN_STAGING_PREFIX}${randomUUID()}`)
  await mkdir(temporaryDir, { recursive: true })
  const paths = runtime.members.map((member) => member.path)
  const verifyMembers = async (root: string): Promise<void> => {
    for (const member of runtime.members) {
      const path = join(root, ...member.path.split('/'))
      await verifyFileSha256(path, member.sha256, `${runtime.label} ${member.path}`)
      if (process.platform !== 'win32') {
        await chmod(path, 0o755)
      }
    }
  }
  try {
    const extractedDir = await downloadAndExtract(runtime, paths, temporaryDir, options)
    await verifyMembers(extractedDir)
    options.signal?.throwIfAborted()
    await rename(extractedDir, folder).catch(async (error: unknown) => {
      // A concurrent start published first; keep its folder only if it holds the same bytes.
      await verifyMembers(folder).catch(() => {
        throw new Error(`${runtime.label} folder is unavailable or corrupted: ${folder}`, {
          cause: error
        })
      })
    })
  } finally {
    await rm(temporaryDir, { recursive: true, force: true })
  }
}

/** Removes the other versions beside `folder` and earlier processes' staging: one host owns the data
 *  root, so nothing runs from them; this process's staging may be a publish in flight. */
export async function removeOtherRuntimeVersions(folder: string): Promise<void> {
  const parent = dirname(folder)
  const entries = await readdir(parent).catch((error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT' ? [] : Promise.reject(error)
  )
  const stale = entries.filter((e) => e !== basename(folder) && !e.startsWith(OWN_STAGING_PREFIX))
  await Promise.all(stale.map((entry) => rm(join(parent, entry), { recursive: true, force: true })))
}

async function downloadAndExtract(
  runtime: PinnedRuntimeArchive,
  members: readonly string[],
  temporaryDir: string,
  options: PinnedRuntimeMaterializeOptions
): Promise<string> {
  const archivePath = join(temporaryDir, archiveName(runtime))
  await downloadVerifiedArchive(
    runtime,
    archivePath,
    options.fetcher ?? getMainHttpClient().fetch,
    options.signal
  )
  options.signal?.throwIfAborted()
  const extractedDir = join(temporaryDir, 'extracted')
  await mkdir(extractedDir)
  const result = await extractRuntimeArchive(
    { label: runtime.label, members },
    archivePath,
    extractedDir,
    options.signal
  )
  options.signal?.throwIfAborted()
  if (result.code !== 0) {
    throw new Error(`${runtime.label} archive extraction failed: ${result.stderr || result.stdout}`)
  }
  return extractedDir
}

/** Hard-link publication: a concurrent winner's identical bytes are kept, never replaced. */
async function publishVerified(
  source: string,
  destination: string,
  sha256: string,
  label: string
): Promise<void> {
  try {
    await link(source, destination)
  } catch (error) {
    if ((await fileSha256(destination)) !== sha256) {
      throw new Error(`${label} cache entry is unavailable or corrupted: ${destination}`, {
        cause: error
      })
    }
  }
  await verifyFileSha256(destination, sha256, label)
}

function nodeRuntimeArchive(target: NodeRuntimeTarget): PinnedRuntimeArchive {
  const asset = pinnedNodeRuntimeAsset(target)
  return {
    label: 'Node',
    url: nodeRuntimeReleaseUrl(asset.source, asset.archive),
    archiveSha256: asset.archiveSha256
  }
}

/** The pinned official archive, uploaded to hosts as published (design D5). */
export function materializeNodeRuntimeArchive(
  target: NodeRuntimeTarget,
  cacheRoot: string,
  options: PinnedRuntimeMaterializeOptions
): Promise<string> {
  return materializeVerifiedRuntimeArchive(
    nodeRuntimeArchive(target),
    join(cacheRoot, 'node', 'archives'),
    options
  )
}

/**
 * Client cache keyed by content (design D2): `node/<executableSha256>/node[.exe]`. Only hosts
 * that cannot extract the archive themselves get the bare executable (Windows SSH vault reads).
 */
export function materializeCachedNodeRuntime(
  target: NodeRuntimeTarget,
  cacheRoot: string,
  options: PinnedRuntimeMaterializeOptions
): Promise<string> {
  const asset = pinnedNodeRuntimeAsset(target)
  const executableName = basename(orcadNodeRuntimeExecutable(target))
  return materializeCachedRuntimeExecutable(
    {
      ...nodeRuntimeArchive(target),
      executableSha256: asset.executableSha256,
      member: nodeRuntimeExecutablePath(target, asset.archive),
      isWindows: target.startsWith('win32-'),
      cachePath: (attempt) =>
        join(
          cacheRoot,
          'node',
          asset.executableSha256,
          `${attempt ? `repair-${attempt}-` : ''}${executableName}`
        )
    },
    options
  )
}

export async function verifyFileSha256(
  path: string,
  expected: string,
  label: string
): Promise<void> {
  const actual = await fileSha256(path)
  if (actual !== expected) {
    throw new Error(`${label} checksum mismatch: expected ${expected}, got ${actual ?? 'missing'}`)
  }
}

export async function fileSha256(path: string): Promise<string | null> {
  try {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk)
    }
    return hash.digest('hex')
  } catch {
    return null
  }
}
