import { describe, expect, it } from 'vitest'
import { parseLinearConfig } from './linear-config.js'

describe('parseLinearConfig', () => {
  const stateKey = 'k'.repeat(32)
  const complete = {
    ORCA_CONNECTOR_LINEAR_WEBHOOK_SECRET: 'lin_wh_secret',
    ORCA_CONNECTOR_LINEAR_CLIENT_ID: 'client',
    ORCA_CONNECTOR_LINEAR_CLIENT_SECRET: 'client-secret',
    ORCA_CONNECTOR_LINEAR_INSTALL_STATE_KEY: stateKey,
    ORCA_CONNECTOR_LINEAR_ORGANIZATION_IDS: 'org-1, org-2'
  }

  it('is off without a webhook secret', () => {
    expect(parseLinearConfig({})).toBeUndefined()
  })

  it('reads the client, state key, allowlist and kill switch', () => {
    expect(parseLinearConfig({ ...complete, ORCA_CONNECTOR_LINEAR_PAUSED: 'true' })).toEqual({
      webhookSecret: 'lin_wh_secret',
      clientId: 'client',
      clientSecret: 'client-secret',
      installStateKey: stateKey,
      organizationIds: new Set(['org-1', 'org-2']),
      paused: true
    })
  })

  it.each([
    ['no client id', 'ORCA_CONNECTOR_LINEAR_CLIENT_ID'],
    ['no client secret', 'ORCA_CONNECTOR_LINEAR_CLIENT_SECRET'],
    ['no state key', 'ORCA_CONNECTOR_LINEAR_INSTALL_STATE_KEY'],
    ['no allowlist', 'ORCA_CONNECTOR_LINEAR_ORGANIZATION_IDS']
  ])('refuses %s', (_name, missing) => {
    expect(() => parseLinearConfig({ ...complete, [missing]: undefined })).toThrow()
  })

  it('refuses a short state key', () => {
    expect(() =>
      parseLinearConfig({ ...complete, ORCA_CONNECTOR_LINEAR_INSTALL_STATE_KEY: 'short' })
    ).toThrow()
  })
})
