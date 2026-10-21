import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { orcadDataRootIsOnLocalDisk } from '../orcad/orcad-data-root-locality'
import { readOrcadProcessIncarnation } from '../orcad/orcad-process-start-time'
import { verifyFileSha256 } from '../node-runtime/pinned-runtime-materializer'
import { readPosixProcessRow } from './provider-process-row-read'

export type ProviderExecSource = {
  executable: string
  sha256: string
  /** The whole signed bundle is copied; its requirement belongs to the running owner. */
  macBundle?: { path: string; requirement: string }
}
export type ProviderExecCode = {
  executable: string
  holdFd(): number
  close(): Promise<void>
}

async function privateCodeRoot(base: string): Promise<string | undefined> {
  const uid = process.getuid?.()
  if (uid === undefined) {
    throw new Error('Provider code requires a POSIX execution host')
  }
  if (!orcadDataRootIsOnLocalDisk(base)) {
    return
  }
  const root = join(base, `orca-provider-exec-${uid}.noindex`)
  try {
    await mkdir(root, { mode: 0o700 })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error
    }
  }
  const stat = await lstat(root)
  if (stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0) {
    return root
  }
  return undefined
}

async function codeCommand(executable: string, args: string[], fd?: number) {
  return runProcess({
    program: executable,
    args,
    timeoutMs: 5_000,
    maxOutputBytes: 4096,
    ...(fd === undefined
      ? {}
      : { stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', fd] })
  })
}

/** Unique owner directories are never reopened for execution, so an exclusive hold can retire them. */
export async function collectProviderExecCode(
  root: string,
  executable: string,
  codeFd: number
): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const path = join(root, entry.name)
    if (entry.name.startsWith('stage-')) {
      try {
        const creator: unknown = JSON.parse(
          Buffer.from(entry.name.slice(6, entry.name.lastIndexOf('.')), 'base64url').toString(
            'utf8'
          )
        )
        if (
          !creator ||
          typeof creator !== 'object' ||
          !('pid' in creator) ||
          !('start' in creator) ||
          typeof creator.pid !== 'number' ||
          !Number.isSafeInteger(creator.pid) ||
          creator.pid <= 1 ||
          typeof creator.start !== 'string'
        ) {
          continue
        }
        const actual = await readPosixProcessRow(creator.pid)
        const boot = readOrcadProcessIncarnation(process.pid)?.bootId
        const otherBoot = boot && 'bootId' in creator && creator.bootId !== boot
        if (actual === 'unverifiable' || (!otherBoot && actual?.startedAt === creator.start)) {
          continue
        }
        try {
          await lstat(join(path, 'hold'))
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            await rm(path, { recursive: true, force: true })
          }
          continue
        }
        const tombstone = join(root, `retired-${randomUUID()}`)
        const retired = await codeCommand(executable, ['collect', path, tombstone], codeFd)
        if (retired.code === 0 && !retired.timedOut && retired.stdout === 'RETIRED\n') {
          await rm(tombstone, { recursive: true, force: true })
        }
      } catch {
        /* An incomplete or unreadable creator is not proof of abandonment. */
      }
    } else if (entry.name.startsWith('owner-')) {
      const tombstone = join(root, `retired-${randomUUID()}`)
      const retired = await codeCommand(executable, ['collect', path, tombstone], codeFd)
      if (retired.code === 0 && !retired.timedOut && retired.stdout === 'RETIRED\n') {
        await rm(tombstone, { recursive: true, force: true })
      }
    } else if (entry.name.startsWith('retired-')) {
      await rm(path, { recursive: true, force: true })
    }
  }
}

/** The owner retains the pin child's shared open description, then hands it directly to each gate. */
export async function prepareProviderExecCode(
  source: ProviderExecSource,
  cacheBases: readonly string[] = [tmpdir(), '/var/tmp', '/tmp', homedir()]
): Promise<ProviderExecCode> {
  let failure: unknown = new Error('Could not prepare private local provider code storage')
  for (const base of new Set(cacheBases)) {
    try {
      const root = await privateCodeRoot(base)
      if (root) {
        return await prepareCodeInRoot(source, root)
      }
    } catch (error) {
      // A local, writable filesystem can still forbid executing the copied helper.
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        !['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOENT'].includes(String(error.code))
      ) {
        throw error
      }
      failure = error
    }
  }
  throw failure
}

async function prepareCodeInRoot(
  source: ProviderExecSource,
  root: string
): Promise<ProviderExecCode> {
  const creator = await readPosixProcessRow(process.pid)
  if (!creator || creator === 'unverifiable') {
    throw new Error('Could not identify the provider code owner')
  }
  const identity = Buffer.from(
    JSON.stringify({
      pid: process.pid,
      start: creator.startedAt,
      ...readOrcadProcessIncarnation(process.pid)
    })
  ).toString('base64url')
  // The directory name records its creator atomically, including the interval before the pin.
  const staging = await mkdtemp(join(root, `stage-${identity}.`))
  const published = join(root, `owner-${randomUUID()}`)
  let hold: Awaited<ReturnType<typeof open>> | undefined
  let nativeStarted = false
  let destination = staging
  try {
    const relativeExecutable = source.macBundle
      ? join('app.noindex', 'Orca Provider Host.app', 'Contents', 'MacOS', 'orca-provider-exec')
      : 'orca-provider-exec'
    const executable = join(staging, relativeExecutable)
    if (source.macBundle) {
      await mkdir(dirname(dirname(dirname(executable))), { recursive: true })
      const bundle = join(staging, 'app.noindex', 'Orca Provider Host.app')
      await cp(source.macBundle.path, bundle, { recursive: true, mode: constants.COPYFILE_FICLONE })
      const signature = await runProcess({
        program: '/usr/bin/codesign',
        args: ['--verify', '--strict', '-R', `=${source.macBundle.requirement}`, bundle],
        timeoutMs: 5_000,
        maxOutputBytes: 8192
      })
      if (signature.code !== 0 || signature.timedOut || signature.outputTruncated) {
        throw new Error('The provider helper copy does not match the running app signature')
      }
    } else {
      await copyFile(source.executable, executable, constants.COPYFILE_FICLONE)
      await chmod(executable, 0o700)
    }
    await verifyFileSha256(executable, source.sha256, 'provider helper')
    const holdPath = join(staging, 'hold')
    hold = await open(holdPath, 'wx+', 0o600)
    nativeStarted = true
    const pinned = await codeCommand(executable, ['pin', holdPath], hold.fd)
    if (pinned.code !== 0 || pinned.timedOut || pinned.stdout !== 'LOCKED\n') {
      throw new Error('Could not retain provider helper code')
    }
    const probe = await open(holdPath, 'r+')
    try {
      const contention = await codeCommand(executable, ['probe-lock', holdPath], probe.fd)
      if (contention.code !== 2 || contention.timedOut) {
        throw new Error('Provider helper code storage does not retain its lock')
      }
    } finally {
      await probe.close()
    }
    await rename(staging, published)
    destination = published
    const code = join(published, relativeExecutable)
    const retained = hold
    let closed = false
    let closing: Promise<void> | undefined
    const collection = collectProviderExecCode(root, code, retained.fd).catch(() => {})
    return {
      executable: code,
      holdFd() {
        if (closed) {
          throw new Error('The provider code owner has stopped')
        }
        return retained.fd
      },
      close() {
        closed = true
        closing ??= collection.then(() => retained.close())
        return closing
      }
    }
  } catch (error) {
    await hold?.close().catch(() => {})
    if (!nativeStarted) {
      await rm(destination, { recursive: true, force: true }).catch(() => {})
    }
    throw error
  }
}
