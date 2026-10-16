import { describe, expect, it } from 'vitest'
import { restorePasswordWithCloudSqlAdmin } from './database-move-cloud-sql-password.js'
import { MoveRefusal } from './database-move-events.js'
import {
  gcsDatabaseTargetPointerStore,
  PointerGenerationConflict
} from './database-move-pointer-store.js'
import type { GoogleMetadataAccess } from './google-metadata-access-token.js'

const google: GoogleMetadataAccess = {
  projectId: async () => 'onorca-cloud',
  accessToken: async () => 'ya29.token',
  forgetAccessToken: () => undefined
}
const PASSWORD = 'pa:ss/w@rd'

describe('database move Cloud SQL password restore', () => {
  it('updates the user and waits for the operation, never echoing the password', async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = []
    let polls = 0
    const fetchImpl: typeof fetch = async (target, init) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(target),
        body: init?.body ? JSON.parse(String(init.body)) : null
      })
      if (init?.method === 'PUT') return Response.json({ name: 'op-1', status: 'PENDING' })
      polls += 1
      return Response.json({ name: 'op-1', status: polls < 2 ? 'RUNNING' : 'DONE' })
    }
    const result = await restorePasswordWithCloudSqlAdmin({
      instanceConnectionName: 'onorca-cloud:us-central1:auth-db',
      user: 'orca_relay',
      password: PASSWORD,
      google,
      fetchImpl,
      pollMs: 1
    })
    expect(result).toEqual({ operation: 'op-1' })
    expect(calls[0]).toEqual({
      method: 'PUT',
      url: 'https://sqladmin.googleapis.com/v1/projects/onorca-cloud/instances/auth-db/users?name=orca_relay',
      body: { name: 'orca_relay', password: PASSWORD }
    })
    expect(calls.slice(1).map((call) => call.url)).toEqual([
      'https://sqladmin.googleapis.com/v1/projects/onorca-cloud/operations/op-1',
      'https://sqladmin.googleapis.com/v1/projects/onorca-cloud/operations/op-1'
    ])
  })

  it('reports a refusal by status only', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(`bad password ${PASSWORD}`, { status: 403 })
    const error = await restorePasswordWithCloudSqlAdmin({
      instanceConnectionName: 'p:r:i',
      user: 'orca_relay',
      password: PASSWORD,
      google,
      fetchImpl
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MoveRefusal)
    expect(JSON.stringify(error)).not.toContain(PASSWORD)
    expect(error instanceof MoveRefusal ? error.details : null).toEqual({ status: 403 })
  })
})

describe('database move pointer store', () => {
  const pointer = {
    version: 1 as const,
    dedicated: {
      instanceConnectionName: 'onorca-cloud:us-central1:relay-db',
      databaseUrlSecret: 'projects/onorca-cloud/secrets/relay-db-url/versions/latest'
    }
  }

  it('reads with the generation and writes only on a matching one', async () => {
    const urls: string[] = []
    const fetchImpl: typeof fetch = async (target, init) => {
      urls.push(`${init?.method ?? 'GET'} ${String(target)}`)
      if (init?.method !== 'POST')
        return Response.json(pointer, { headers: { 'x-goog-generation': '17' } })
      return new URL(String(target)).searchParams.get('ifGenerationMatch') === '17'
        ? Response.json({ generation: '18' })
        : new Response('', { status: 412 })
    }
    const store = gcsDatabaseTargetPointerStore({
      bucket: 'onorca-cloud-relay-control',
      google,
      fetchImpl
    })
    expect(await store.read()).toEqual({ pointer, generation: '17' })
    expect(await store.write(pointer, '17')).toBe('18')
    await expect(store.write(pointer, '16')).rejects.toBeInstanceOf(PointerGenerationConflict)
    expect(urls[0]).toBe(
      'GET https://storage.googleapis.com/storage/v1/b/onorca-cloud-relay-control/o/database-target.json?alt=media'
    )
    expect(urls[1]).toBe(
      'POST https://storage.googleapis.com/upload/storage/v1/b/onorca-cloud-relay-control/o?uploadType=media&name=database-target.json&ifGenerationMatch=17'
    )
  })

  it('treats a missing object as no pointer', async () => {
    const store = gcsDatabaseTargetPointerStore({
      bucket: 'b',
      google,
      fetchImpl: async () => new Response('', { status: 404 })
    })
    expect(await store.read()).toBeNull()
  })
})
