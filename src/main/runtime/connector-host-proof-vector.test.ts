import { describe, expect, it } from 'vitest'
import vector from '../../../cloud/packages/connector-contract/src/connector-host-proof-vector.json'
import {
  CONNECTOR_HOST_CHALLENGE_PLAINTEXT_DOMAIN,
  CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN
} from '../../shared/connector-cloud-contract'
import {
  encodeText,
  hostChallengeAckProof,
  openHostChallengeEnvelope,
  parseHostChallengeTranscript
} from './host-challenge-envelope'

const hostSecretKey = Buffer.from(vector.hostSecretKeyB64, 'base64')
const sealed = {
  peerEphemeralPublicKeyB64: vector.challenge.gatewayEphemeralPublicKeyB64,
  nonceB64: vector.challenge.nonceB64,
  ciphertextB64: vector.challenge.ciphertextB64,
  hostSecretKey
}

// Replay the cloud's checked-in vector so the two workspaces cannot drift apart on the domains.
describe('connector host proof vector', () => {
  it('opens under the connector domain and answers with the expected proof', () => {
    const envelope = openHostChallengeEnvelope({
      ...sealed,
      plaintextDomain: CONNECTOR_HOST_CHALLENGE_PLAINTEXT_DOMAIN
    })
    expect(envelope).not.toBeNull()
    expect(Buffer.from(envelope!.transcript).toString('base64')).toBe(vector.transcriptB64)
    expect(parseHostChallengeTranscript(envelope!.transcript)?.get('protocol')).toEqual(
      encodeText(CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN)
    )
    expect(
      hostChallengeAckProof({
        secret: envelope!.secret,
        transcript: envelope!.transcript,
        proofDomain: CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN
      })
    ).toBe(vector.proofB64)
  })

  it('never opens as a push challenge', () => {
    expect(
      openHostChallengeEnvelope({ ...sealed, plaintextDomain: 'orca-push-host-challenge/v1' })
    ).toBeNull()
  })
})
