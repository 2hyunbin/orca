// Mirror of cloud/packages/connector-contract/src for the machine side of the Orca Cloud connector.
import { z } from 'zod'
import type { PendingPrompt } from './agent-pending-prompt'

export const CONNECTOR_CONTRACT_VERSION = 1

// Every route is POST except hello (PUT), and takes `Authorization: Bearer <connector token>`.
export const CONNECTOR_PATHS = {
  hello: '/v1/connector/hello',
  poll: '/v1/connector/poll',
  acks: '/v1/connector/acks',
  events: '/v1/connector/events',
  replies: '/v1/connector/replies'
} as const

export const CONNECTOR_FEATURES = ['answer', 'cancel', 'reply'] as const

export const CONNECTOR_CLIENT_LIMITS = {
  pollTimeoutMs: 70_000,
  minDeadlineLeftMs: 10_000,
  maxLastAssistantMessageBytes: 8 * 1024
} as const

// Machine-side readers: they keep what this Orca uses and ignore fields a newer cloud adds.
export const ConnectorErrorResponse = z.object({ error: z.string().min(1) })

const ConnectorConversation = z.object({
  source: z.literal('slack'),
  externalId: z.string().min(1)
})
export type ConnectorConversation = z.infer<typeof ConnectorConversation>

const DeliveryBase = {
  deliveryId: z.string().min(1),
  expiresAt: z.number().int().positive(),
  conversation: ConnectorConversation
}

export const ConnectorDelivery = z.discriminatedUnion('kind', [
  z.object({
    ...DeliveryBase,
    kind: z.literal('start'),
    agent: z.string().min(1),
    placeId: z.string().min(1),
    prompt: z.string().min(1)
  }),
  z.object({ ...DeliveryBase, kind: z.literal('send'), text: z.string().min(1) }),
  z.object({
    ...DeliveryBase,
    kind: z.literal('answer'),
    promptId: z.string().min(1),
    optionId: z.string().min(1)
  }),
  z.object({ ...DeliveryBase, kind: z.literal('cancel') })
])
export type ConnectorDelivery = z.infer<typeof ConnectorDelivery>

/** Enough of a delivery this Orca cannot read to settle it as unsupported. */
export const ConnectorDeliveryId = z.object({ deliveryId: z.string().min(1) })

// Each delivery and the control are read one by one, so one this Orca cannot read never drops the rest.
export const ConnectorPollResponse = z.object({
  serverNow: z.number().int().positive(),
  holdMs: z.number().int().nonnegative(),
  unsettled: z
    .array(z.object({ deliveryId: z.string().min(1), conversation: ConnectorConversation }))
    .optional(),
  deliveries: z.array(z.unknown()),
  control: z.unknown().optional()
})

export const ConnectorPollControl = z.union([
  z.object({ stop: z.string().min(1) }),
  z.object({ pausedForMs: z.number().int().positive() }),
  z.object({ reconnect: z.literal(true) })
])
export type ConnectorPollControl = z.infer<typeof ConnectorPollControl>

export type ConnectorProject = {
  placeId: string
  name: string
  remote?: string
  kind: 'git' | 'folder'
  where: { kind: 'local' | 'ssh' | 'wsl'; label?: string }
}

export type ConnectorDeliveryResult =
  | { outcome: 'accepted'; reopened?: true }
  | { outcome: 'refused' | 'unknown'; reason: string }
  | { outcome: 'expired' | 'unsupported' }

export type ConnectorAck =
  | { deliveryId: string; step: 'received' }
  | { deliveryId: string; step: 'done'; result: ConnectorDeliveryResult }

type PaneEvent = { conversation: ConnectorConversation; paneKey: string }

export type ConnectorEvent =
  | (PaneEvent & { kind: 'linked'; agent: string })
  | (PaneEvent & { kind: 'prompt'; prompt: PendingPrompt })
  | (PaneEvent & { kind: 'turn-started'; at: number })
  | (PaneEvent & {
      kind: 'turn-ended'
      turnId: number
      at: number
      stopReason: string | null
      lastAssistantMessage?: string
    })
  | {
      kind: 'snapshot'
      conversations: (PaneEvent & {
        agent: string
        working: boolean
        prompt: PendingPrompt | null
      })[]
    }
