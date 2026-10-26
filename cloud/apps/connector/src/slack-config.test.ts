import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseSlackConfig } from './slack-config.js'

describe('parseSlackConfig', () => {
  const key = randomBytes(32).toString('base64')

  it('is off without a token key', () => {
    expect(parseSlackConfig({})).toBeUndefined()
  })

  it('reads the kill switch and key', () => {
    expect(
      parseSlackConfig({
        ORCA_CONNECTOR_SLACK_PAUSED: 'true',
        ORCA_CONNECTOR_SLACK_TOKEN_KEY: key
      })
    ).toEqual({ paused: true, tokenKey: Buffer.from(key, 'base64') })
  })

  it('refuses a short key', () => {
    expect(() => parseSlackConfig({ ORCA_CONNECTOR_SLACK_TOKEN_KEY: 'AAAA' })).toThrow()
  })
})
