import { Base6432ByteSchema, Base64Url32ByteSchema, EpochMsSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'
import { ConnectorHostDescription, ConnectorHostIdSchema } from './connector-wire-scalars.js'

export const ConnectorSignInStartRequestSchema = z.object({
  v: z.literal(1),
  hostPublicKeyB64: Base6432ByteSchema,
  ...ConnectorHostDescription
})

// No pre-filled verification link: the person must type userCode themselves.
export const ConnectorSignInStartResponseSchema = z.object({
  deviceCode: Base64Url32ByteSchema,
  userCode: z.string().min(1),
  verificationUri: z.url(),
  expiresAt: EpochMsSchema,
  interval: z.number().int().positive()
})

export const ConnectorSignInPollRequestSchema = z.object({
  v: z.literal(1),
  deviceCode: Base64Url32ByteSchema
})

const PollInterval = { interval: z.number().int().positive() }

// authorized carries no secret, so it repeats until the request expires.
export const ConnectorSignInPollResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['pending', 'slow_down', 'denied', 'expired']), ...PollInterval }),
  z.object({
    status: z.literal('authorized'),
    ...PollInterval,
    hostId: ConnectorHostIdSchema,
    account: z.object({ email: z.string().min(1) })
  })
])

export const ConnectorSignOutRequestSchema = z.object({ v: z.literal(1) })

export type ConnectorSignInStartRequest = z.infer<typeof ConnectorSignInStartRequestSchema>
export type ConnectorSignInStartResponse = z.infer<typeof ConnectorSignInStartResponseSchema>
export type ConnectorSignInPollRequest = z.infer<typeof ConnectorSignInPollRequestSchema>
export type ConnectorSignInPollResponse = z.infer<typeof ConnectorSignInPollResponseSchema>
