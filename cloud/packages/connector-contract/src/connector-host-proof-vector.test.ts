import { createHmac } from 'node:crypto'
import { buildPushHostProofTranscript, PUSH_HOST_PROOF_TRANSCRIPT_DOMAIN } from '@orca-cloud/push-contract'
import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'
import {
  CONNECTOR_HOST_CHALLENGE_PLAINTEXT_DOMAIN,
  CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN
} from './connector-endpoints.js'
import vector from './connector-host-proof-vector.json' with { type: 'json' }

const bytes = (b64: string): Buffer => Buffer.from(b64, 'base64')

function protocolField(domain: string): Buffer {
  const name = Buffer.from('protocol')
  const value = Buffer.from(domain)
  const header = Buffer.alloc(4)
  header.writeUInt32BE(name.byteLength)
  const valueHeader = Buffer.alloc(4)
  valueHeader.writeUInt32BE(value.byteLength)
  return Buffer.concat([header, name, valueHeader, value])
}

// The desktop replays this vector too (src/main/runtime/connector-host-proof-vector.test.ts).
describe('connector host proof vector', () => {
  it('is push transcript layout under the connector domain', () => {
    const push = Buffer.from(
      buildPushHostProofTranscript({
        gatewayOrigin: vector.gatewayOrigin,
        gatewayEphemeralPublicKey: bytes(vector.challenge.gatewayEphemeralPublicKeyB64),
        challengeNonce: bytes(vector.challenge.nonceB64),
        challengeId: vector.challenge.challengeId,
        issuedAt: vector.issuedAt,
        expiresAt: vector.challenge.expiresAt,
        hostFingerprint: vector.hostFingerprint,
        hostPublicKey: bytes(vector.hostPublicKeyB64)
      })
    )
    const pushProtocol = protocolField(PUSH_HOST_PROOF_TRANSCRIPT_DOMAIN)
    expect(push.subarray(0, pushProtocol.byteLength)).toEqual(pushProtocol)
    expect(bytes(vector.transcriptB64)).toEqual(
      Buffer.concat([
        protocolField(CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN),
        push.subarray(pushProtocol.byteLength)
      ])
    )
  })

  it('seals the challenge and answers it with the checked-in proof', () => {
    const transcript = bytes(vector.transcriptB64)
    const secret = bytes(vector.challengeSecretB64)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(transcript.byteLength)
    const plaintext = Buffer.concat([
      Buffer.from(`${CONNECTOR_HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`),
      length,
      transcript,
      secret
    ])
    const sealed = nacl.box(
      plaintext,
      bytes(vector.challenge.nonceB64),
      bytes(vector.hostPublicKeyB64),
      bytes(vector.gatewayEphemeralSecretKeyB64)
    )
    expect(Buffer.from(sealed).toString('base64')).toBe(vector.challenge.ciphertextB64)
    const proof = createHmac('sha256', secret)
      .update(`${CONNECTOR_HOST_PROOF_TRANSCRIPT_DOMAIN}\0ack\0`)
      .update(transcript)
      .digest('base64')
    expect(proof).toBe(vector.proofB64)
  })
})
