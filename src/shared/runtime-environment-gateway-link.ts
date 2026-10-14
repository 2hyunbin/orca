import { z } from 'zod'
import { ManagedRuntimeGatewayDescriptorSchema } from './managed-runtime-gateway-contract'

export const RuntimeEnvironmentGatewayLinkSchema = z.strictObject({
  controllerEnvironmentId: z.string().min(1).max(256),
  controllerPairingRevision: z.number().finite(),
  controllerHostKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  descriptor: ManagedRuntimeGatewayDescriptorSchema
})
export type RuntimeEnvironmentGatewayLink = z.infer<typeof RuntimeEnvironmentGatewayLinkSchema>
export const MANAGED_GATEWAY_INERT_TOKEN = 'managed-gateway-reference-needs-controller'
