import { z } from 'zod'

export const MANAGED_RUNTIME_SESSION_CAPABILITY = 'pairing.managed-runtime-session.v1' as const
export const MANAGED_RUNTIME_SESSION_LIFETIME_MS = 30_000
export const ManagedRuntimeSessionOpenSchema = z.strictObject({
  subjectKey: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  grants: z
    .array(z.enum(['desktop-control']))
    .max(1)
    .optional()
})
export const ManagedRuntimeSessionSelectorSchema = z.strictObject({
  deviceId: z.string().min(1).max(128)
})
export type ManagedRuntimeSessionGrant = {
  deviceId: string
  token: string
  expiresAt: number
}
