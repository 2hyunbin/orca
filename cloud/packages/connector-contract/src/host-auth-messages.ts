import {
  Base6432ByteSchema,
  Base64Raw24ByteSchema,
  Base64Url32ByteSchema,
  BoundedCiphertextSchema,
  EpochMsSchema,
  OpaqueIdSchema
} from '@orca-cloud/push-contract'
import { z } from 'zod'
import { ConnectorHostIdSchema } from './connector-wire-scalars.js'

// Push's handshake fields, but stripping instead of strict so later fields can be added.
export const ConnectorHostChallengeRequestSchema = z.object({
  v: z.literal(1),
  hostPublicKeyB64: Base6432ByteSchema
})

export const ConnectorHostChallengeResponseSchema = z.object({
  challengeId: OpaqueIdSchema,
  gatewayEphemeralPublicKeyB64: Base6432ByteSchema,
  nonceB64: Base64Raw24ByteSchema,
  ciphertextB64: BoundedCiphertextSchema,
  expiresAt: EpochMsSchema
})

export const ConnectorHostSessionRequestSchema = z.object({
  v: z.literal(1),
  challengeId: OpaqueIdSchema,
  proofB64: Base6432ByteSchema
})

// hostId is the key fingerprint push calls hostFingerprint; one name, sent once.
export const ConnectorHostSessionResponseSchema = z.object({
  sessionToken: Base64Url32ByteSchema,
  expiresAt: EpochMsSchema,
  hostId: ConnectorHostIdSchema
})

export type ConnectorHostChallengeRequest = z.infer<typeof ConnectorHostChallengeRequestSchema>
export type ConnectorHostChallengeResponse = z.infer<typeof ConnectorHostChallengeResponseSchema>
export type ConnectorHostSessionRequest = z.infer<typeof ConnectorHostSessionRequestSchema>
export type ConnectorHostSessionResponse = z.infer<typeof ConnectorHostSessionResponseSchema>
