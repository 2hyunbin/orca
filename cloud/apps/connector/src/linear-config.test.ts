import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseLinearConfig } from './linear-config.js'

describe('parseLinearConfig', () => {
  const key = randomBytes(32).toString('base64')
  const complete = {
    ORCA_CONNECTOR_LINEAR_WEBHOOK_SECRET: 'lin_wh_secret',
    ORCA_CONNECTOR_LINEAR_CLIENT_ID: 'client',
    ORCA_CONNECTOR_LINEAR_CLIENT_SECRET: 'client-secret',
    ORCA_CONNECTOR_LINEAR_ORGANIZATION_IDS: 'org-1, org-2',
    ORCA_CONNECTOR_LINEAR_TOKEN_KEY: key
  }

  it('is off without a webhook secret', () => {
    expect(parseLinearConfig({})).toBeUndefined()
  })

  it('reads the client, allowlist, kill switch and key', () => {
    expect(parseLinearConfig({ ...complete, ORCA_CONNECTOR_LINEAR_PAUSED: 'true' })).toEqual({
      webhookSecret: 'lin_wh_secret',
      clientId: 'client',
      clientSecret: 'client-secret',
      organizationIds: new Set(['org-1', 'org-2']),
      paused: true,
      tokenKey: Buffer.from(key, 'base64')
    })
  })

  it.each([
    ['no client id', 'ORCA_CONNECTOR_LINEAR_CLIENT_ID'],
    ['no client secret', 'ORCA_CONNECTOR_LINEAR_CLIENT_SECRET'],
    ['no allowlist', 'ORCA_CONNECTOR_LINEAR_ORGANIZATION_IDS'],
    ['no key', 'ORCA_CONNECTOR_LINEAR_TOKEN_KEY']
  ])('refuses %s', (_name, missing) => {
    expect(() => parseLinearConfig({ ...complete, [missing]: undefined })).toThrow()
  })

  it('refuses a short key', () => {
    expect(() =>
      parseLinearConfig({ ...complete, ORCA_CONNECTOR_LINEAR_TOKEN_KEY: 'AAAA' })
    ).toThrow('ORCA_CONNECTOR_LINEAR_TOKEN_KEY must be 32 bytes')
  })
})
