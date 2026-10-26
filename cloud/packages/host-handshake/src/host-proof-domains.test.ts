import { createHmac } from 'node:crypto'
import { openInMemoryCloudDatabase, type CloudDatabase } from '@orca-cloud/cloud-database'
import {
  buildHostProofMacInput,
  PUSH_HOST_PROOF_DOMAINS,
  PUSH_LIMITS,
  type HostProofDomains
} from '@orca-cloud/push-contract'
import nacl from 'tweetnacl'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostChallengeStore, type IssuedHostChallenge } from './host-challenge-store.js'

// The connector's domains as published by @orca-cloud/connector-contract.
const CONNECTOR_DOMAINS: HostProofDomains = {
  transcript: 'orca-connector-host-proof/v1',
  challengePlaintext: 'orca-connector-host-challenge/v1'
}
const ORIGIN = 'https://gateway.onorca.dev'
const CHALLENGE_TABLE = (table: string): string => `CREATE TABLE ${table} (
  challenge_id TEXT PRIMARY KEY, host_fingerprint TEXT NOT NULL, secret_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL, consumed_at BIGINT)`

// Opens the sealed challenge and MACs its transcript under `domains`, whatever the challenge's own.
function answer(
  challenge: IssuedHostChallenge,
  host: nacl.BoxKeyPair,
  domains: HostProofDomains
): string {
  const plaintext = nacl.box.open(
    Buffer.from(challenge.ciphertextB64, 'base64'),
    Buffer.from(challenge.nonceB64, 'base64'),
    Buffer.from(challenge.gatewayEphemeralPublicKeyB64, 'base64'),
    host.secretKey
  )
  if (!plaintext) {
    throw new Error('challenge did not open')
  }
  const bytes = Buffer.from(plaintext)
  const lengthAt = bytes.indexOf(0) + 1
  const transcript = bytes.subarray(lengthAt + 4, lengthAt + 4 + bytes.readUInt32BE(lengthAt))
  const secret = bytes.subarray(bytes.byteLength - 32)
  return createHmac('sha256', secret)
    .update(buildHostProofMacInput(domains, transcript))
    .digest('base64')
}

describe('host proof domains', () => {
  let database: CloudDatabase
  let stores: { push: HostChallengeStore; connector: HostChallengeStore }

  beforeEach(async () => {
    database = await openInMemoryCloudDatabase([
      CHALLENGE_TABLE('push_challenges'),
      CHALLENGE_TABLE('connector_challenges')
    ])
    const store = (table: string, proofDomains: HostProofDomains): HostChallengeStore =>
      new HostChallengeStore(database, {
        table,
        gatewayOrigin: ORIGIN,
        proofDomains,
        ttlMs: PUSH_LIMITS.challengeTtlMs,
        clockSkewToleranceMs: PUSH_LIMITS.clockSkewToleranceMs
      })
    stores = {
      push: store('push_challenges', PUSH_HOST_PROOF_DOMAINS),
      connector: store('connector_challenges', CONNECTOR_DOMAINS)
    }
  })

  afterEach(async () => {
    await database.close()
  })

  it.each([
    ['push', PUSH_HOST_PROOF_DOMAINS, CONNECTOR_DOMAINS],
    ['connector', CONNECTOR_DOMAINS, PUSH_HOST_PROOF_DOMAINS]
  ] as const)('a %s challenge rejects a proof made under the other domain', async (name, own, other) => {
    const host = nacl.box.keyPair()
    const publicKeyB64 = Buffer.from(host.publicKey).toString('base64')
    const crossed = (await stores[name].issue(publicKeyB64))!
    await expect(stores[name].verify(crossed.challengeId, answer(crossed, host, other))).resolves.toEqual({
      ok: false,
      reason: 'proof_mismatch'
    })
    const matched = (await stores[name].issue(publicKeyB64))!
    await expect(stores[name].verify(matched.challengeId, answer(matched, host, own))).resolves.toEqual({
      ok: true,
      hostFingerprint: matched.hostFingerprint
    })
  })
})
