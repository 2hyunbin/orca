import {
  CONNECTOR_PATHS,
  ConnectorHostChallengeResponseSchema,
  ConnectorHostSessionResponseSchema
} from '@orca-cloud/connector-contract'
import { deriveHostFingerprint } from '@orca-cloud/host-handshake'
import { PUSH_HOST_PROOF_DOMAINS } from '@orca-cloud/push-contract'
import { afterEach, describe, expect, it } from 'vitest'
import {
  answerChallenge,
  cleanupConnectorHarnesses,
  createConnectorHarness,
  hiddenField,
  hostKeypair,
  pauseBefore,
  publicKeyB64
} from './connector-server-harness.test-fixture.js'

afterEach(cleanupConnectorHarnesses)

async function linkedHarness() {
  const harness = await createConnectorHarness()
  const host = hostKeypair()
  const browser = await harness.signedInBrowser()
  await harness.approve(browser, (await harness.startSignIn(host)).started!.userCode)
  const session = ConnectorHostSessionResponseSchema.parse(
    await (await harness.machineSession(host)).json()
  )
  const signOut = () =>
    harness.json(
      CONNECTOR_PATHS.signOut,
      { v: 1 },
      { authorization: `Bearer ${session.sessionToken}` }
    )
  return { harness, host, browser, session, signOut }
}

describe('connector machine sessions', () => {
  it('refuses a session to a key nobody linked', async () => {
    const harness = await createConnectorHarness()
    const refused = await harness.machineSession(hostKeypair())
    expect(refused.status).toBe(403)
    await expect(refused.json()).resolves.toEqual({ error: 'host_not_linked' })
  })

  it('issues a linked machine a session named by its host id', async () => {
    const { host, session } = await linkedHarness()
    expect(session.hostId).toBe(deriveHostFingerprint(host.publicKey))
  })

  it('signs a machine out: its session ends and its key is no longer linked', async () => {
    const { harness, host, signOut } = await linkedHarness()
    expect((await signOut()).status).toBe(204)
    expect((await signOut()).status).toBe(401)
    await expect((await harness.machineSession(host)).json()).resolves.toEqual({
      error: 'host_not_linked'
    })
  })

  it('revokes from the machines page: sessions end and new ones are refused', async () => {
    const { harness, host, browser, signOut } = await linkedHarness()
    const page = await (await browser.get('/machines')).text()
    expect(page).toContain('build-box')
    const hostId = deriveHostFingerprint(host.publicKey)
    const revoked = await browser.post(`/v1/account/hosts/${hostId}/revoke`, {
      csrf: hiddenField(page, 'csrf')
    })
    expect(revoked.status).toBe(303)
    expect(await (await browser.get('/machines')).text()).toContain('No machines are connected.')
    expect((await signOut()).status).toBe(401)
    await expect((await harness.machineSession(host)).json()).resolves.toEqual({
      error: 'host_revoked'
    })
  })

  it('checks the link on every request, not only when the session is made', async () => {
    const { harness, host, signOut } = await linkedHarness()
    await harness.database.query('UPDATE connector_hosts SET revoked_at = 1 WHERE host_id = ?', [
      deriveHostFingerprint(host.publicKey)
    ])
    const refused = await signOut()
    expect(refused.status).toBe(403)
    await expect(refused.json()).resolves.toEqual({ error: 'host_revoked' })
  })

  it('ends every earlier session when a key is linked again', async () => {
    const { harness, host, browser, signOut } = await linkedHarness()
    // The state a session request leaves when it races a revoke: revoked, but its session kept.
    await harness.database.query('UPDATE connector_hosts SET revoked_at = 1 WHERE host_id = ?', [
      deriveHostFingerprint(host.publicKey)
    ])
    await harness.approve(browser, (await harness.startSignIn(host)).started!.userCode)
    expect((await signOut()).status).toBe(401)
  })

  it('lets no session minted across a revoke survive it', async () => {
    let gate!: ReturnType<typeof pauseBefore>
    const harness = await createConnectorHarness({}, (database) => {
      gate = pauseBefore(database, 'INSERT INTO connector_sessions')
      return gate.database
    })
    const host = hostKeypair()
    const browser = await harness.signedInBrowser()
    await harness.approve(browser, (await harness.startSignIn(host)).started!.userCode)
    const page = await (await browser.get('/machines')).text()
    const pending = harness.machineSession(host)
    await gate.atStatement
    // Revoke and relink both try to run while the session insert is held.
    const relinked = browser
      .post(`/v1/account/hosts/${deriveHostFingerprint(host.publicKey)}/revoke`, {
        csrf: hiddenField(page, 'csrf')
      })
      .then(async () => {
        await harness.approve(browser, (await harness.startSignIn(host)).started!.userCode)
      })
    await new Promise((resolve) => setTimeout(resolve, 200))
    gate.release()
    const session = ConnectorHostSessionResponseSchema.parse(await (await pending).json())
    await relinked
    const stale = await harness.json(
      CONNECTOR_PATHS.signOut,
      { v: 1 },
      { authorization: `Bearer ${session.sessionToken}` }
    )
    expect(stale.status).toBe(401)
  })

  it('ignores a revoke from an account that does not own the machine', async () => {
    const { harness, host } = await linkedHarness()
    const stranger = await harness.signedInBrowser({ userId: 'user-2', email: 'eve@example.com' })
    const page = await (await stranger.get('/host-login')).text()
    await stranger.post(`/v1/account/hosts/${deriveHostFingerprint(host.publicKey)}/revoke`, {
      csrf: hiddenField(page, 'csrf')
    })
    expect((await harness.machineSession(host)).status).toBe(200)
  })

  it('rejects a proof answered under push domains', async () => {
    const { harness, host } = await linkedHarness()
    const challenge = ConnectorHostChallengeResponseSchema.parse(
      await (
        await harness.json(CONNECTOR_PATHS.hostChallenge, { v: 1, hostPublicKeyB64: publicKeyB64(host) })
      ).json()
    )
    const crossed = await harness.json(CONNECTOR_PATHS.hostSession, {
      v: 1,
      challengeId: challenge.challengeId,
      proofB64: answerChallenge(challenge, host, PUSH_HOST_PROOF_DOMAINS)
    })
    expect(crossed.status).toBe(401)
    await expect(crossed.json()).resolves.toEqual({ error: 'invalid_proof' })
  })
})
