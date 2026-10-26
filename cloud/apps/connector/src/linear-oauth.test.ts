import { describe, expect, it } from 'vitest'
import { createLinearTokenEndpoint, type LinearTokenGrant } from './linear-oauth.js'

// Request and response shapes from https://linear.app/developers/oauth-2-0-authentication
// (form-encoded, Basic client auth, expires_in 86399, rotating refresh token).
const NOW = 1_800_000_000_000
const refresh: LinearTokenGrant = { grantType: 'refresh_token', refreshToken: 'refresh-1' }

function endpoint(status: number, body: unknown) {
  const calls: RequestInit[] = []
  const request = async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {})
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }
  const tokens = createLinearTokenEndpoint(
    { clientId: 'client', clientSecret: 'secret' },
    request,
    () => NOW
  )
  return { tokens, calls }
}

describe('createLinearTokenEndpoint', () => {
  const issued = {
    access_token: 'access-2',
    token_type: 'Bearer',
    expires_in: 86399,
    scope: 'read write app:assignable app:mentionable',
    refresh_token: 'refresh-2'
  }

  it('refreshes with Basic client auth and returns the rotated pair', async () => {
    const { tokens, calls } = endpoint(200, issued)
    expect(await tokens(refresh)).toEqual({
      kind: 'ok',
      tokens: { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: NOW + 86_399_000 }
    })
    expect(calls[0]?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from('client:secret').toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded'
    })
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]?.body)))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1'
    })
  })

  it('exchanges an install code', async () => {
    const { tokens, calls } = endpoint(200, issued)
    await tokens({
      grantType: 'authorization_code',
      code: 'code-1',
      redirectUri: 'https://c.example/cb'
    })
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]?.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'https://c.example/cb'
    })
  })

  it('fails when Linear refuses the grant', async () => {
    const { tokens } = endpoint(400, { error: 'invalid_grant', error_description: 'expired' })
    expect(await tokens(refresh)).toEqual({ kind: 'failed', error: 'invalid_grant' })
  })

  it('is unknown when the grant may have been used', async () => {
    expect(await endpoint(503, 'unavailable').tokens(refresh)).toEqual({ kind: 'unknown' })
    expect(await endpoint(200, { access_token: 'a' }).tokens(refresh)).toEqual({ kind: 'unknown' })
    const failing = createLinearTokenEndpoint({ clientId: 'c', clientSecret: 's' }, async () => {
      throw new Error('timeout')
    })
    expect(await failing(refresh)).toEqual({ kind: 'unknown' })
  })
})
