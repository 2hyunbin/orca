import { EpochMsSchema, OpaqueIdSchema, SequenceSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'
import { CONNECTOR_LIMITS } from './connector-limits.js'
import { ConnectorConversationSchema, PlaceIdSchema } from './connector-wire-scalars.js'

export const ConnectorPollRequestSchema = z.object({ v: z.literal(1), helloRev: SequenceSchema })

const DeliveryBase = {
  deliveryId: OpaqueIdSchema,
  seq: SequenceSchema,
  expiresAt: EpochMsSchema,
  conversation: ConnectorConversationSchema
}

const KnownDeliverySchema = z.discriminatedUnion('kind', [
  z.object({
    ...DeliveryBase,
    kind: z.literal('start'),
    agent: z.string().min(1),
    placeId: PlaceIdSchema,
    prompt: z.string().min(1)
  }),
  z.object({ ...DeliveryBase, kind: z.literal('send'), text: z.string().min(1) }),
  z.object({
    ...DeliveryBase,
    kind: z.literal('answer'),
    promptId: OpaqueIdSchema,
    optionId: OpaqueIdSchema
  }),
  z.object({ ...DeliveryBase, kind: z.literal('cancel') })
])

// A kind or shape this machine does not know settles as unsupported instead of failing the whole poll.
const UnsupportedDeliverySchema = z
  .object({ deliveryId: OpaqueIdSchema })
  .transform(({ deliveryId }) => ({ deliveryId, kind: 'unsupported' as const }))

export const ConnectorDeliverySchema = z.union([KnownDeliverySchema, UnsupportedDeliverySchema])

// An unknown control is ignored, never fatal.
const PollControlSchema = z
  .union([
    z.object({ stop: z.string().min(1) }),
    z.object({ pausedForMs: z.number().int().positive() }),
    z.object({ reconnect: z.literal(true) })
  ])
  .optional()
  .catch(undefined)

export const ConnectorPollResponseSchema = z.object({
  v: z.literal(1),
  serverNow: EpochMsSchema,
  holdMs: z.number().int().nonnegative().max(CONNECTOR_LIMITS.pollTimeoutMs),
  // First poll of a session only: deliveries received by an earlier process but never done.
  unsettled: z
    .array(z.object({ deliveryId: OpaqueIdSchema, conversation: ConnectorConversationSchema }))
    .default([]),
  deliveries: z.array(ConnectorDeliverySchema).max(CONNECTOR_LIMITS.maxDeliveriesPerPoll),
  control: PollControlSchema
})

export const ConnectorDeliveryResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('accepted'), reopened: z.literal(true).optional() }),
  z.object({ outcome: z.literal('refused'), reason: z.string().min(1) }),
  // Includes `no_local_record` when a restart finds no receipt; never resent.
  z.object({ outcome: z.literal('unknown'), reason: z.string().min(1) }),
  z.object({ outcome: z.literal('expired') }),
  z.object({ outcome: z.literal('unsupported') })
])

// received once the seam call has written its receipt; done when it settles. First done wins.
export const ConnectorAcksRequestSchema = z.object({
  v: z.literal(1),
  acks: z
    .array(
      z.discriminatedUnion('step', [
        z.object({ deliveryId: OpaqueIdSchema, step: z.literal('received') }),
        z.object({
          deliveryId: OpaqueIdSchema,
          step: z.literal('done'),
          result: ConnectorDeliveryResultSchema
        })
      ])
    )
    .min(1)
})

export type ConnectorPollRequest = z.infer<typeof ConnectorPollRequestSchema>
export type ConnectorDelivery = z.infer<typeof ConnectorDeliverySchema>
export type ConnectorPollResponse = z.infer<typeof ConnectorPollResponseSchema>
export type ConnectorDeliveryResult = z.infer<typeof ConnectorDeliveryResultSchema>
export type ConnectorAcksRequest = z.infer<typeof ConnectorAcksRequestSchema>
