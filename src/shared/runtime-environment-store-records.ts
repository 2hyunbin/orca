import { existsSync, linkSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import {
  PersistedRuntimeEnvironmentSchema,
  type PersistedRuntimeEnvironment
} from './runtime-environments'
import { hardenExistingSecureFile } from './secure-file'

const ENVIRONMENTS_FILE = 'orca-environments.json'
export const MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES = 1024 * 1024

export type RuntimeEnvironmentStoreErrorCode = 'invalid_argument' | 'runtime_error'

export class RuntimeEnvironmentStoreError extends Error {
  readonly code: RuntimeEnvironmentStoreErrorCode

  constructor(code: RuntimeEnvironmentStoreErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeEnvironmentStoreError'
    this.code = code
  }
}

export function getEnvironmentStorePath(userDataPath: string): string {
  return join(userDataPath, ENVIRONMENTS_FILE)
}

// Records stay opaque so one bad or newer-format entry cannot hide the rest.
const StoreEnvelopeSchema = z.object({
  version: z.literal(1),
  environments: z.array(z.unknown())
})

/** A record this build cannot read; it is rewritten verbatim so a newer build still finds it. */
export type UnreadableEnvironmentRecord = { id: string | undefined; raw: unknown }

export type EnvironmentStoreRecords = {
  environments: PersistedRuntimeEnvironment[]
  unreadable: UnreadableEnvironmentRecord[]
}

function recordId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || !('id' in raw)) {
    return undefined
  }
  return typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : undefined
}

function parseRecord(raw: unknown): PersistedRuntimeEnvironment | undefined {
  // Preserve future kind records unread: parsing as plain pairings would strip their type on rewrite.
  if (typeof raw === 'object' && raw !== null && 'kind' in raw) {
    return undefined
  }
  const parsed = PersistedRuntimeEnvironmentSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

/** The envelope must be valid; individual records that are not are set aside, not rejected. */
export function readEnvironmentStoreRecords(
  userDataPath: string,
  options: { requireStoreFile?: boolean } = {}
): EnvironmentStoreRecords {
  const path = getEnvironmentStorePath(userDataPath)
  if (!options.requireStoreFile && !existsSync(path)) {
    return { environments: [], unreadable: [] }
  }
  let text: string
  try {
    hardenExistingSecureFile(path)
    text = readNodeFileSyncWithinLimit(
      path,
      MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES
    ).buffer.toString('utf8')
  } catch {
    throw invalidStoreError(path)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // Non-JSON bytes (e.g. NUL-filled after a crash) hold no server to keep, and failing every
    // save would strand the user (#18766). Set them aside so the store reads as missing.
    if (!quarantineCorruptEnvironmentStore(path, text) || options.requireStoreFile) {
      throw invalidStoreError(path)
    }
    return { environments: [], unreadable: [] }
  }
  let records: unknown[]
  try {
    // Valid JSON in another shape may be a newer build's store, so it fails closed.
    records = StoreEnvelopeSchema.parse(json).environments
  } catch {
    throw invalidStoreError(path)
  }
  const result: EnvironmentStoreRecords = { environments: [], unreadable: [] }
  for (const raw of records) {
    const environment = parseRecord(raw)
    if (environment) {
      result.environments.push(environment)
    } else {
      result.unreadable.push({ id: recordId(raw), raw })
    }
  }
  return result
}

function invalidStoreError(path: string): RuntimeEnvironmentStoreError {
  return new RuntimeEnvironmentStoreError(
    'runtime_error',
    `Could not read Orca environments at ${path}; the file is invalid.`
  )
}

/** Returns whether the corrupt file was moved to a backup beside it. */
function quarantineCorruptEnvironmentStore(path: string, corruptText: string): boolean {
  const backupPath = `${path}.corrupt-${Date.now()}-${process.pid}`
  try {
    renameSync(path, backupPath)
  } catch (error) {
    // Another reader already moved it aside.
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
  }
  // Another process may have published a valid store between our read and the rename.
  if (readTextOrNull(backupPath) !== corruptText) {
    try {
      linkSync(backupPath, path)
      unlinkSync(backupPath)
    } catch {
      // A newer store already took the name; the moved copy stays as a backup.
    }
    return false
  }
  console.warn(`[runtime-environments] ${path} was not valid JSON; moved it to ${backupPath}.`)
  return true
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const warned = new Set<string>()

/** Logs once per distinct message so per-round-trip reads do not flood the log. */
export function warnUnreadableEnvironmentState(message: string): void {
  if (warned.has(message)) {
    return
  }
  warned.add(message)
  console.warn(`[runtime-environments] ${message}`)
}
