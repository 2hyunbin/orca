import { MoveRefusal } from './database-move-events.js'
import type { GoogleMetadataAccess } from './google-metadata-access-token.js'
import {
  DATABASE_TARGET_POINTER_OBJECT,
  parseDatabaseTargetPointer,
  type DatabaseTargetPointer
} from './relay-database-target-pointer.js'

const STORAGE_ROOT = 'https://storage.googleapis.com'
const REQUEST_TIMEOUT_MS = 5_000

export type StoredDatabaseTargetPointer = { pointer: DatabaseTargetPointer; generation: string }

// Every write is a compare-and-swap on the object generation the tool last read, so a pointer
// changed by anyone else in between fails the write instead of being overwritten.
export type DatabaseTargetPointerStore = {
  read(): Promise<StoredDatabaseTargetPointer | null>
  write(pointer: DatabaseTargetPointer, ifGenerationMatch: string): Promise<string>
  // Ends the move: processes read the pointer as absent and serve DATABASE_URL alone.
  delete(ifGenerationMatch: string): Promise<void>
}

export class PointerGenerationConflict extends MoveRefusal {
  constructor() {
    super('pointer_changed_by_someone_else')
  }
}

// Needs storage.objects.get and .create/.delete on database-target.json in the control bucket.
export function gcsDatabaseTargetPointerStore(input: {
  bucket: string
  google: GoogleMetadataAccess
  fetchImpl?: typeof fetch
}): DatabaseTargetPointerStore {
  const fetchImpl = input.fetchImpl ?? fetch
  const object = encodeURIComponent(DATABASE_TARGET_POINTER_OBJECT)
  const bucket = encodeURIComponent(input.bucket)
  const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        authorization: `Bearer ${await input.google.accessToken()}`,
        ...(init.body ? { 'content-type': 'application/json' } : {})
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }).catch(() => {
      throw new MoveRefusal('pointer_store_unreachable')
    })
    if (response.status === 401) input.google.forgetAccessToken()
    return response
  }
  return {
    read: async () => {
      const response = await request(`${STORAGE_ROOT}/storage/v1/b/${bucket}/o/${object}?alt=media`)
      if (response.status === 404) {
        void response.body?.cancel().catch(() => undefined)
        return null
      }
      const generation = response.headers.get('x-goog-generation')
      if (!response.ok || !generation) {
        void response.body?.cancel().catch(() => undefined)
        throw new MoveRefusal('pointer_read_failed', { status: response.status })
      }
      const parsed = parseDatabaseTargetPointer(await response.json().catch(() => null))
      if (!parsed?.flags) throw new MoveRefusal('pointer_malformed')
      return { pointer: parsed.flags, generation }
    },
    delete: async (ifGenerationMatch) => {
      const url = new URL(`${STORAGE_ROOT}/storage/v1/b/${bucket}/o/${object}`)
      url.searchParams.set('ifGenerationMatch', ifGenerationMatch)
      const response = await request(url.toString(), { method: 'DELETE' })
      void response.body?.cancel().catch(() => undefined)
      if (response.status === 412) throw new PointerGenerationConflict()
      if (!response.ok) throw new MoveRefusal('pointer_delete_failed', { status: response.status })
    },
    write: async (pointer, ifGenerationMatch) => {
      const url = new URL(`${STORAGE_ROOT}/upload/storage/v1/b/${bucket}/o`)
      url.searchParams.set('uploadType', 'media')
      url.searchParams.set('name', DATABASE_TARGET_POINTER_OBJECT)
      url.searchParams.set('ifGenerationMatch', ifGenerationMatch)
      const response = await request(url.toString(), {
        method: 'POST',
        body: JSON.stringify(pointer)
      })
      if (response.status === 412) {
        void response.body?.cancel().catch(() => undefined)
        throw new PointerGenerationConflict()
      }
      const body: unknown = await response.json().catch(() => null)
      const generation =
        typeof body === 'object' && body !== null && 'generation' in body
          ? String(body.generation)
          : ''
      if (!response.ok || !generation)
        throw new MoveRefusal('pointer_write_failed', { status: response.status })
      return generation
    }
  }
}
