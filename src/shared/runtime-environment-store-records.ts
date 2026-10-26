import { constants, copyFileSync, existsSync } from 'node:fs'
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
  /** The file exists but holds only NUL/whitespace; the next write backs it up and replaces it. */
  blankFile?: true
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
    // A crash can publish the name over zeroed data (#18766); those bytes hold no server, and failing
    // every save would strand the user. Other bad JSON may hold servers, so it still fails closed.
    if (options.requireStoreFile || !/^[\s\0]*$/.test(text)) {
      throw invalidStoreError(path)
    }
    return { environments: [], unreadable: [], blankFile: true }
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

/** Copies (never moves) the blank store aside, so concurrent readers never see the name missing. */
export function backUpBlankEnvironmentStore(userDataPath: string): void {
  const path = getEnvironmentStorePath(userDataPath)
  const backupPath = `${path}.corrupt-${Date.now()}-${process.pid}`
  copyFileSync(path, backupPath, constants.COPYFILE_EXCL)
  hardenExistingSecureFile(backupPath)
  console.warn(`[runtime-environments] ${path} held no data; kept a copy at ${backupPath}.`)
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
