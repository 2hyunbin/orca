import { CONNECTOR_LIMITS, CONNECTOR_PATHS } from '@orca-cloud/connector-contract'
import { deriveHostFingerprint } from '@orca-cloud/host-handshake'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupConnectorHarnesses,
  createConnectorHarness,
  hiddenField,
  HOST_IP,
  hostKeypair,
  PUBLIC_URL
} from './connector-server-harness.test-fixture.js'

afterEach(cleanupConnectorHarnesses)

describe('connector machine sign-in', () => {
  it('links a machine once its owner types the code and allows it', async () => {
    const harness = await createConnectorHarness()
    const host = hostKeypair()
    const { response, started } = await harness.startSignIn(host)
    expect(response.status).toBe(201)
    expect(started?.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(started?.verificationUri).toBe(`${PUBLIC_URL}/host-login`)
    expect(started?.interval).toBe(CONNECTOR_LIMITS.signInPollIntervalSeconds)
    const deviceCode = started!.deviceCode
    const poll = async () =>
      await (await harness.json(CONNECTOR_PATHS.signInPoll, { v: 1, deviceCode })).json()

    harness.advance(5_000)
    await expect(poll()).resolves.toEqual({ status: 'pending', interval: 5 })
    // Polling before the interval elapses slows the machine down by one step.
    await expect(poll()).resolves.toEqual({ status: 'slow_down', interval: 10 })

    const browser = await harness.signedInBrowser()
    const confirm = await browser.post('/host-login', {
      csrf: hiddenField(await (await browser.get('/host-login')).text(), 'csrf'),
      userCode: started!.userCode.toLowerCase()
    })
    const page = await confirm.text()
    expect(page).toContain('build-box')
    expect(page).toContain(HOST_IP)
    expect(page).toContain('Only allow this if you just ran')

    const decided = await harness.approve(browser, started!.userCode)
    expect(decided.status).toBe(200)
    expect(await decided.text()).toContain('Connected')

    harness.advance(10_000)
    const authorized = {
      status: 'authorized',
      interval: 10,
      hostId: deriveHostFingerprint(host.publicKey),
      account: { email: 'ada@example.com' }
    }
    await expect(poll()).resolves.toEqual(authorized)
    // authorized carries no secret, so a lost reply is simply asked for again.
    harness.advance(10_000)
    await expect(poll()).resolves.toEqual(authorized)
  })

  it('tells the machine when its request is denied or expires', async () => {
    const harness = await createConnectorHarness()
    const browser = await harness.signedInBrowser()
    const denied = (await harness.startSignIn(hostKeypair())).started!
    await harness.approve(browser, denied.userCode, false)
    const expiring = (await harness.startSignIn(hostKeypair())).started!

    harness.advance(5_000)
    await expect(
      (await harness.json(CONNECTOR_PATHS.signInPoll, { v: 1, deviceCode: denied.deviceCode })).json()
    ).resolves.toMatchObject({ status: 'denied' })

    harness.advance(CONNECTOR_LIMITS.signInTtlMs)
    await expect(
      (await harness.json(CONNECTOR_PATHS.signInPoll, { v: 1, deviceCode: expiring.deviceCode })).json()
    ).resolves.toMatchObject({ status: 'expired' })
    const late = await browser.post('/host-login', {
      csrf: hiddenField(await (await browser.get('/host-login')).text(), 'csrf'),
      userCode: expiring.userCode
    })
    expect(late.status).toBe(404)
  })

  it('refuses a key already linked to another account', async () => {
    const harness = await createConnectorHarness()
    const host = hostKeypair()
    const owner = await harness.signedInBrowser()
    await harness.approve(owner, (await harness.startSignIn(host)).started!.userCode)

    const stranger = await harness.signedInBrowser({ userId: 'user-2', email: 'eve@example.com' })
    const again = (await harness.startSignIn(host)).started!
    const refused = await harness.approve(stranger, again.userCode)
    expect(refused.status).toBe(409)
    harness.advance(5_000)
    await expect(
      (await harness.json(CONNECTOR_PATHS.signInPoll, { v: 1, deviceCode: again.deviceCode })).json()
    ).resolves.toMatchObject({ status: 'denied' })
  })

  it('caps pending requests per client address', async () => {
    const harness = await createConnectorHarness()
    for (let i = 0; i < CONNECTOR_LIMITS.signInPendingPerIp; i++) {
      expect((await harness.startSignIn(hostKeypair())).response.status).toBe(201)
    }
    const limited = (await harness.startSignIn(hostKeypair())).response
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
  })

  it('rate-limits code guesses per signed-in account', async () => {
    const harness = await createConnectorHarness()
    const browser = await harness.signedInBrowser()
    const csrf = hiddenField(await (await browser.get('/host-login')).text(), 'csrf')
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) {
      statuses.push((await browser.post('/host-login', { csrf, userCode: 'AAAA-AAAA' })).status)
    }
    expect(statuses.slice(0, 10).every((status) => status === 404)).toBe(true)
    expect(statuses[10]).toBe(429)
  })
})
