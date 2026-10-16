import { describe, expect, it } from 'vitest'
import type { GoogleMetadataAccess } from './google-metadata-access-token.js'
import {
  parseDedicatedDatabaseUrl,
  readDedicatedDatabaseCredentials
} from './relay-dedicated-database-secret.js'

const PASSWORD = 'pa:ss/w@rd'
const URL_VALUE = `postgresql://orca_relay:${encodeURIComponent(PASSWORD)}@/orca_relay?host=/cloudsql/p:r:i`
const SECRET = 'projects/onorca-cloud/secrets/relay-db-url/versions/latest'

const google: GoogleMetadataAccess = {
  projectId: async () => 'onorca-cloud',
  accessToken: async () => 'ya29.token',
  forgetAccessToken: () => undefined
}

describe('dedicated database secret', () => {
  it('reads user, password and database from the Secret Manager payload', async () => {
    const requests: string[] = []
    const fetchImpl: typeof fetch = async (target, init) => {
      requests.push(`${String(target)} ${new Headers(init?.headers).get('authorization')}`)
      return Response.json({ payload: { data: Buffer.from(URL_VALUE).toString('base64') } })
    }
    expect(await readDedicatedDatabaseCredentials(SECRET, google, fetchImpl)).toEqual({
      user: 'orca_relay',
      password: PASSWORD,
      database: 'orca_relay'
    })
    expect(requests).toEqual([
      `https://secretmanager.googleapis.com/v1/${SECRET}:access Bearer ya29.token`
    ])
  })

  it('never puts the value in an error', async () => {
    const failures = await Promise.all(
      [
        async () => new Response('denied', { status: 403 }),
        async () => Response.json({ payload: {} }),
        async () =>
          Response.json({ payload: { data: Buffer.from(`postgresql://${PASSWORD}@/`).toString('base64') } })
      ].map(async (fetchImpl) =>
        await readDedicatedDatabaseCredentials(SECRET, google, fetchImpl).catch((error: unknown) => error)
      )
    )
    expect(failures.map((error) => String(error))).toEqual([
      'Error: dedicated_database_secret_read',
      'Error: dedicated_database_secret_payload',
      'Error: dedicated_database_secret_parse'
    ])
    expect(() => parseDedicatedDatabaseUrl(`not a url ${PASSWORD}`)).toThrow(
      /^dedicated_database_secret_parse$/
    )
  })
})
