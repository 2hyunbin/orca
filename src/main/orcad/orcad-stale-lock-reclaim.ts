/**
 * `--reclaim-stale-lock`: clears an orcad instance lock that no automatic start may judge (#32177).
 *
 * A lock on a home other machines may share names a PID that is evidence only on the machine that
 * issued it, so a start after a reboot refuses it rather than guess. This command gathers what this
 * machine can check (same host, a different boot, an old record, nothing answering at the holder's
 * endpoint), shows it, and clears the lock only when the user confirms that no other machine
 * sharing the home runs Orca. Losing contact is never treated as exit without that confirmation.
 */
import { readdirSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { hostname } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import {
  acquireOrcadInstanceLock,
  ORCAD_LOCK_FILE_NAME,
  parseOrcadInstanceLockRecord,
  type OrcadInstanceLockHooks,
  type OrcadLockRecord
} from './orcad-instance-lock'
import { readBoundedLockFile } from './orcad-instance-lock-reclaim'
import { orcadLockHolderLocality } from './orcad-lock-holder-locality'
import { orcadDataRootIsOnLocalDisk } from './orcad-data-root-locality'
import { readOrcadProcessIncarnation } from './orcad-process-start-time'
import { hasErrorCode } from '../daemon/daemon-process-inspection'
import { resolveUserDataPath } from './orcad-app-paths'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'
import { readRuntimeMetadata } from '../runtime/runtime-metadata'
import { RUNTIME_SOCKET_NAME_REGEX } from '../runtime/runtime-rpc/runtime-rpc-socket-metadata'
import { ORCAD_RECLAIM_STALE_LOCK_FLAG } from '../../shared/orcad-stale-lock-reclaim'

// A holder that just took the lock may not be listening yet; its silence would prove nothing.
export const ORCAD_STALE_LOCK_MIN_AGE_MS = 2 * 60_000
const ENDPOINT_PROBE_TIMEOUT_MS = 1_500

/** `silent` only on a refusal the OS gives for an endpoint nobody listens on; anything else is not. */
export type OrcadEndpointProbe = 'answers' | 'silent' | 'unknown'

export type OrcadStaleLockReclaimHooks = {
  now?: () => number
  hostname?: () => string
  bootId?: () => string | null
  machineIdentity?: () => string | null
  dataRootIsOnLocalDisk?: (dataRoot: string) => boolean
  probeEndpoint?: (endpoint: string) => Promise<OrcadEndpointProbe>
  lockHooks?: OrcadInstanceLockHooks
}

export type OrcadStaleLockReclaimResult = { exitCode: number; message: string }

export async function reclaimStaleOrcadInstanceLock(
  dataRoot: string,
  options: { yes: boolean },
  hooks: OrcadStaleLockReclaimHooks = {}
): Promise<OrcadStaleLockReclaimResult> {
  const lockPath = join(dataRoot, ORCAD_LOCK_FILE_NAME)
  const contents = readBoundedLockFile(lockPath)
  if (contents === null) {
    // Only a confirmed absence is nothing to do; a permission or I/O error hides a lock.
    return lockIsAbsent(lockPath)
      ? { exitCode: 0, message: `No orcad instance lock at ${lockPath}; nothing to reclaim.` }
      : refuse(`The lock ${lockPath} cannot be read. Check it by hand before deleting it.`)
  }
  const holder = parseOrcadInstanceLockRecord(contents)
  if (!holder) {
    return refuse(`The lock ${lockPath} is not a complete record. Check it by hand.`)
  }
  const refusal = await staleLockRefusal(dataRoot, lockPath, holder, hooks)
  if (refusal) {
    return refuse(`${refusal} Not reclaiming ${lockPath}.`)
  }
  const evidence = describeEvidence(holder, lockPath, hooks)
  const currentBoot = (hooks.bootId ?? currentBootId)()
  if (!options.yes) {
    return refuse(
      `${evidence}\nOrca cannot prove from here that it stopped, because this data root may be ` +
        'shared with other machines. Make sure no other machine sharing this home runs Orca for ' +
        `this profile, then re-run with ${ORCAD_RECLAIM_STALE_LOCK_FLAG} --yes.`
    )
  }
  try {
    // Why through the normal acquire: it reclaims only this exact record, through the same
    // race-safe rename, and still refuses if that PID is running here under the same identity.
    acquireOrcadInstanceLock(dataRoot, {
      ...hooks.lockHooks,
      // Only the record shown above; a reclaimer cut short by the same reboot is just as stale.
      reclaimConfirmed: (record, role) =>
        role === 'holder'
          ? record.nonce === holder.nonce
          : record.host === holder.host && !!record.bootId && record.bootId !== currentBoot
    }).release()
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }
  return { exitCode: 0, message: `${evidence}\nReclaimed ${lockPath}. Orca can start now.` }
}

/** Why each check refuses, or null once every one passed. */
async function staleLockRefusal(
  dataRoot: string,
  lockPath: string,
  holder: OrcadLockRecord,
  hooks: OrcadStaleLockReclaimHooks
): Promise<string | null> {
  const bootId = (hooks.bootId ?? currentBootId)()
  const machineIdentity = (hooks.machineIdentity ?? profileStateAccessMachineIdentity)()
  const self = { ...(machineIdentity ? { machineIdentity } : {}), ...(bootId ? { bootId } : {}) }
  const locality = orcadLockHolderLocality(holder, self, () =>
    (hooks.dataRootIsOnLocalDisk ?? orcadDataRootIsOnLocalDisk)(dataRoot)
  )
  if (locality === 'local') {
    return 'This machine can judge this lock itself, so a normal start reclaims it if its holder exited.'
  }
  if (locality === 'foreign') {
    return 'The lock was written by another machine (a different machine id).'
  }
  const host = (hooks.hostname ?? hostname)()
  if (!holder.host) {
    return 'The lock does not record which host wrote it (an older orcad wrote it).'
  }
  if (holder.host !== host) {
    return `The lock was written on host ${holder.host}, not this host (${host}).`
  }
  if (!holder.bootId || !bootId) {
    return 'The lock or this machine has no boot id to compare.'
  }
  if (holder.bootId === bootId) {
    return 'The lock comes from this boot, so its holder may still be running here.'
  }
  const now = (hooks.now ?? Date.now)()
  const writtenMs = Math.max(Date.parse(holder.acquiredAt), statOrNull(lockPath)?.mtimeMs ?? now)
  if (!(now - writtenMs >= ORCAD_STALE_LOCK_MIN_AGE_MS)) {
    return `The lock is less than ${ORCAD_STALE_LOCK_MIN_AGE_MS / 60_000} minutes old.`
  }
  const endpoints = holderEndpoints(dataRoot, holder.pid)
  if (!endpoints) {
    return 'The runtime record in the data root cannot be read.'
  }
  const probe = hooks.probeEndpoint ?? probeOrcadEndpoint
  for (const endpoint of endpoints) {
    const answer = await probe(endpoint)
    if (answer !== 'silent') {
      return answer === 'answers'
        ? `Its endpoint ${endpoint} still answers, so it is running.`
        : `Its endpoint ${endpoint} could not be checked.`
    }
  }
  return null
}

function describeEvidence(
  holder: OrcadLockRecord,
  lockPath: string,
  hooks: OrcadStaleLockReclaimHooks
): string {
  const now = (hooks.now ?? Date.now)()
  const ageMinutes = Math.round((now - Date.parse(holder.acquiredAt)) / 60_000)
  return (
    `${holder.role === 'desktop' ? 'The Orca desktop app' : 'orcad'} pid ${holder.pid} on host ` +
    `${holder.host} took ${lockPath} ${ageMinutes} minutes ago, in boot ${holder.bootId} ` +
    `(this machine is now in boot ${(hooks.bootId ?? currentBootId)()}), and nothing answers ` +
    'at its endpoints.'
  )
}

/** The holder's sockets and recorded transports; null when its runtime record is unreadable. */
function holderEndpoints(dataRoot: string, pid: number): string[] | null {
  const endpoints = new Set<string>()
  try {
    const metadata = readRuntimeMetadata(dataRoot)
    if (metadata?.pid === pid) {
      for (const transport of metadata.transports ?? []) {
        endpoints.add(transport.endpoint)
      }
    }
  } catch {
    return null
  }
  try {
    for (const entry of readdirSync(dataRoot)) {
      if (RUNTIME_SOCKET_NAME_REGEX.exec(entry)?.[1] === String(pid)) {
        endpoints.add(join(dataRoot, entry))
      }
    }
  } catch {
    return null
  }
  return [...endpoints]
}

export function probeOrcadEndpoint(endpoint: string): Promise<OrcadEndpointProbe> {
  let target: { path: string } | { host: string; port: number }
  try {
    const url = /^wss?:\/\//u.test(endpoint) ? new URL(endpoint) : null
    // Why strip brackets: URL keeps them around an IPv6 host, which the socket API rejects.
    target = url
      ? { host: url.hostname.replace(/^\[|\]$/gu, ''), port: Number(url.port || 80) }
      : { path: endpoint }
  } catch {
    return Promise.resolve('unknown')
  }
  return new Promise((resolve) => {
    const socket = createConnection(target)
    const finish = (answer: OrcadEndpointProbe): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(answer)
    }
    const timer = setTimeout(() => finish('unknown'), ENDPOINT_PROBE_TIMEOUT_MS)
    socket.once('connect', () => finish('answers'))
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? 'silent' : 'unknown')
    )
  })
}

function currentBootId(): string | null {
  return readOrcadProcessIncarnation(process.pid)?.bootId ?? null
}

function lockIsAbsent(path: string): boolean {
  try {
    statSync(path)
    return false
  } catch (error) {
    return hasErrorCode(error, 'ENOENT')
  }
}

function statOrNull(path: string): { mtimeMs: number } | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function refuse(message: string): OrcadStaleLockReclaimResult {
  return { exitCode: 1, message }
}

/** `orcad --reclaim-stale-lock [--yes]`, on the data root this orcad would serve. */
export async function runOrcadStaleLockReclaimCommandAndExit(argv: string[]): Promise<never> {
  const unknown = argv.slice(1).filter((arg) => arg !== '--yes')
  const result = unknown.length
    ? refuse(`Unknown argument for ${ORCAD_RECLAIM_STALE_LOCK_FLAG}: ${unknown[0]}`)
    : await reclaimStaleOrcadInstanceLock(resolveUserDataPath(), { yes: argv.includes('--yes') })
  ;(result.exitCode === 0 ? console.log : console.error)(result.message)
  process.exit(result.exitCode)
}
