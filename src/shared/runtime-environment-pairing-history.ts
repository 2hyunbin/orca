import { z } from 'zod'
import { WslDistroIdSchema } from './wsl-host-deployment-link'

// Why 4: covers repeated update/rollback re-pairs before the lazy browser host first starts.
export const MAX_RUNTIME_ENVIRONMENT_PREVIOUS_PAIRINGS = 4

/**
 * Pairings Orca-driven re-pairs replaced, most recent first; older builds strip it, losing
 * only a fallback. Capped on write, not parse, so a newer build's longer list stays readable.
 */
export const RuntimeEnvironmentPreviousPairingsSchema = z.array(
  z.object({
    pairingRevision: z.number().finite(),
    pairedDeviceId: z.string().min(1).optional(),
    /** WSL registration GUID the pairing was made under; absent when it was unknown. */
    wslDistroId: WslDistroIdSchema.optional()
  })
)

export type RuntimeEnvironmentPreviousPairing = z.infer<
  typeof RuntimeEnvironmentPreviousPairingsSchema
>[number]

type PairedRuntimeEnvironmentHistory = {
  createdAt: number
  pairingRevision?: number
  pairedDeviceId?: string
  pairingWslDistroId?: string
  previousPairings?: readonly RuntimeEnvironmentPreviousPairing[]
}

/** The history an Orca-driven re-pair records: the replaced pairing first, then its history. */
export function runtimeEnvironmentPreviousPairings(
  environment: PairedRuntimeEnvironmentHistory
): RuntimeEnvironmentPreviousPairing[] {
  const replaced: RuntimeEnvironmentPreviousPairing = {
    pairingRevision: environment.pairingRevision ?? environment.createdAt,
    ...(environment.pairedDeviceId ? { pairedDeviceId: environment.pairedDeviceId } : {}),
    ...(environment.pairingWslDistroId ? { wslDistroId: environment.pairingWslDistroId } : {})
  }
  return [replaced, ...(environment.previousPairings ?? [])].slice(
    0,
    MAX_RUNTIME_ENVIRONMENT_PREVIOUS_PAIRINGS
  )
}
