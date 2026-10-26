import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AUTH_URL,
  cleanupConnectorHarnesses,
  createConnectorHarness,
  PUBLIC_URL,
  testBrowser
} from './connector-server-harness.test-fixture.js'

afterEach(cleanupConnectorHarnesses)

describe('connector web sign-in', () => {
  it('runs PKCE against the auth service and keeps no refresh token', async () => {
    const harness = await createConnectorHarness()
    const browser = testBrowser(harness.request)
    const redirect = await browser.get('/machines')
    expect(redirect.status).toBe(302)
    const authorize = new URL(redirect.headers.get('location') ?? '')
    expect(authorize.origin + authorize.pathname).toBe(`${AUTH_URL}/v1/desktop/auth/authorize`)
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: 'orca-connector',
      redirect_uri: `${PUBLIC_URL}/auth/callback`,
      code_challenge_method: 'S256',
      response_type: 'code'
    })

    const callback = await browser.get(
      `/auth/callback?code=code-1&state=${authorize.searchParams.get('state')}`
    )
    expect(callback.status).toBe(303)
    expect(callback.headers.get('location')).toBe('/machines')
    const [exchange, logout] = harness.issuer.calls
    expect(exchange?.path).toBe('/v1/desktop/auth/session')
    expect(
      createHash('sha256')
        .update(String(exchange?.body.codeVerifier))
        .digest('base64url')
    ).toBe(authorize.searchParams.get('code_challenge'))
    expect(exchange?.body).toMatchObject({
      code: 'code-1',
      redirectUri: `${PUBLIC_URL}/auth/callback`,
      localProfileId: authorize.searchParams.get('local_profile_id')
    })
    expect(logout).toEqual({
      path: '/v1/desktop/auth/logout',
      body: { refreshToken: 'refresh-user-1' }
    })
    expect(await (await browser.get('/machines')).text()).toContain('ada@example.com')
  })

  it('refuses a callback whose state does not match the browser', async () => {
    const harness = await createConnectorHarness()
    const browser = testBrowser(harness.request)
    await browser.get('/host-login')
    const callback = await browser.get('/auth/callback?code=code-1&state=forged')
    expect(callback.status).toBe(400)
    expect(harness.issuer.calls).toEqual([])
  })

  it('refuses a form posted without the session-bound token', async () => {
    const harness = await createConnectorHarness()
    const browser = await harness.signedInBrowser()
    const forged = await browser.post('/host-login', { csrf: 'forged', userCode: 'AAAA-AAAA' })
    expect(forged.status).toBe(403)
  })
})
