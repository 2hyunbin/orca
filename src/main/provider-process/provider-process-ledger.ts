import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { getAppEnvironment } from '../../shared/app-environment'
import { hasUnambiguousStartTime } from '../pty-descendant-termination'
import { waitForProcessExitUntil } from './provider-process-exit-deadline'
import { readPosixProcessRow } from './provider-process-row-read'
import {
  captureProviderGroup,
  observeProviderGroup,
  stopRecordedProviderGroup,
  type ProviderGroupMember
} from './provider-process-group'

const memberSchema = z.object({
  pid: z.number().int().min(2),
  pgid: z.number().int().min(2),
  startedAt: z.string()
})
const entrySchema = z.object({
  version: z.literal(1),
  origin: z.literal('direct'),
  token: z.string().uuid(),
  directory: z.string(),
  createdAt: z.number(),
  pgid: z.number().int().min(2),
  owner: memberSchema,
  members: memberSchema.array()
})
type Entry = z.infer<typeof entrySchema>
const ENTRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
let startup: Promise<void> | undefined

function ledgerDirectory(): string {
  return join(getAppEnvironment().getPath('userData'), 'provider-processes')
}

async function readEntry(path: string): Promise<Entry | null> {
  try {
    const parsed = entrySchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function removeEntry(path: string, token: string): Promise<void> {
  if ((await readEntry(path))?.token === token) {
    await unlink(path).catch(() => {})
  }
}

export type ProviderLaunchRecord = {
  capture(): Promise<void>
  members(): readonly ProviderGroupMember[]
  retire(): Promise<void>
}

/** Recording is advisory: a filesystem failure cannot refuse an agent launch. */
export function recordProviderLaunch(pgid: number, token = randomUUID()): ProviderLaunchRecord {
  let members: ProviderGroupMember[] = []
  let entry: Entry | undefined
  let retired = false
  let tail = Promise.resolve()
  let directory: string | undefined
  try {
    directory = ledgerDirectory()
  } catch {
    /* No application environment in isolated consumers. */
  }
  const path = directory ? join(directory, `${token}.json`) : undefined
  const capture = (): Promise<void> => {
    tail = tail
      .then(async () => {
        if (retired) {
          return
        }
        const observed = await captureProviderGroup(pgid)
        for (const row of observed) {
          if (!members.some((old) => old.pid === row.pid && old.startedAt === row.startedAt)) {
            members.push(row)
          }
        }
        if (!path || !directory || members.length === 0) {
          return
        }
        const boundary = Date.now()
        const owner = await readPosixProcessRow(process.pid)
        if (
          !owner ||
          owner === 'unverifiable' ||
          (owner.startResolution === 'second' &&
            !hasUnambiguousStartTime(owner.startedAt, boundary))
        ) {
          return
        }
        entry ??= {
          version: 1,
          origin: 'direct',
          token,
          directory,
          createdAt: Date.now(),
          pgid,
          owner,
          members
        }
        entry.members = members.filter((member) => member.pgid === pgid)
        await mkdir(directory, { recursive: true })
        const temporary = `${path}.tmp`
        await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 })
        await rename(temporary, path)
      })
      .catch((error: unknown) =>
        console.warn('[provider-process] ownership recording failed', error)
      )
    return tail
  }
  const record: ProviderLaunchRecord = {
    capture,
    members: () => members,
    async retire() {
      retired = true
      await tail
      if (path) {
        await removeEntry(path, token)
      }
    }
  }
  void capture()
  return record
}

async function reapEntry(directory: string, name: string): Promise<void> {
  const path = join(directory, name)
  const entry = await readEntry(path)
  if (!entry || entry.directory !== directory || `${entry.token}.json` !== name) {
    await unlink(path).catch(() => {})
    return
  }
  if (Date.now() - entry.createdAt > ENTRY_MAX_AGE_MS) {
    await removeEntry(path, entry.token)
    return
  }
  const owner = await readPosixProcessRow(entry.owner.pid)
  if (owner === 'unverifiable') {
    return
  }
  if (owner && owner.startedAt === entry.owner.startedAt) {
    return
  }
  const owns = async (): Promise<boolean> => {
    const current = await readEntry(path)
    const freshOwner = await readPosixProcessRow(entry.owner.pid)
    return (
      current?.token === entry.token &&
      current.createdAt === entry.createdAt &&
      freshOwner !== 'unverifiable' &&
      (!freshOwner || freshOwner.startedAt !== entry.owner.startedAt)
    )
  }
  const verdict = await stopRecordedProviderGroup(entry.pgid, entry.members, owns)
  if (verdict === 'exited' || !(await anyRecordedMember(entry))) {
    await removeEntry(path, entry.token)
  }
}

async function anyRecordedMember(entry: Entry): Promise<boolean> {
  for (const member of entry.members) {
    const row = await readPosixProcessRow(member.pid)
    if (row === 'unverifiable' || (row && row.startedAt === member.startedAt)) {
      return true
    }
  }
  return false
}

/** Independent of chat restoration, so disposable launches are recovered too. */
export function recoverProviderLaunches(): Promise<void> {
  if (process.platform === 'win32') {
    return Promise.resolve()
  }
  startup ??= (async () => {
    const directory = ledgerDirectory()
    const names = (await readdir(directory).catch(() => [])).filter((name) =>
      /^[\da-f-]+\.json$/.test(name)
    )
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(4, names.length) }, async () => {
        while (next < names.length) {
          const name = names[next++]
          if (name) {
            await reapEntry(directory, name)
          }
        }
      })
    )
  })().catch((error: unknown) => console.warn('[provider-process] restart cleanup failed', error))
  return startup
}

/** A direct-origin record prevents legacy recovery from treating the agent as an old supervisor. */
export async function hasRecordedProviderLaunch(pgid: number): Promise<boolean> {
  try {
    const directory = ledgerDirectory()
    for (const name of await readdir(directory)) {
      if (!/^[\da-f-]+\.json$/.test(name)) {
        continue
      }
      const entry = await readEntry(join(directory, name))
      if (entry?.directory === directory && entry.pgid === pgid) {
        return true
      }
    }
  } catch {
    /* An unknown store is not direct-origin proof. */
  }
  return false
}

/** A timed-out or moved writer still owns its home until its exact identity disappears. */
export async function verifyProviderWriters(
  record: ProviderLaunchRecord | undefined,
  pgid: number,
  groupRetired: boolean
): Promise<boolean> {
  const deadline = Date.now() + 2_000
  let verified = false
  const verification = (async () => {
    await record?.capture()
    for (const member of record?.members() ?? []) {
      if (Date.now() >= deadline) {
        return false
      }
      const row = await readPosixProcessRow(member.pid)
      if (row === 'unverifiable' || (row && row.startedAt === member.startedAt)) {
        return false
      }
    }
    return groupRetired || (await observeProviderGroup(pgid, 0)) === 'exited'
  })()
  await waitForProcessExitUntil(
    verification.then(
      (value) => {
        verified = value
      },
      () => {}
    ),
    2_000
  )
  return verified
}
