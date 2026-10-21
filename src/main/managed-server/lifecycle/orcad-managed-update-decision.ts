/**
 * Whether a connect may put this app's orcad build on a host, shared by SSH and WSL: a host a
 * newer Orca activated is never downgraded, and a build the host rolled back from or that already
 * failed is not retried. The fenced activation applies it again, so a race cannot bypass it.
 */
import type { OrcadActivationRecord } from '../activation/orcad-activation-record'
import {
  refuseOrcadHostDowngrade,
  type OrcadHostVersionRefusal
} from '../../ssh/orcad-host-version-admission'

export type ManagedOrcadAutoUpdateSkip =
  | 'current'
  | 'no-template'
  | 'rolled-back'
  | 'failed-before'
  | 'migrating'
  | OrcadHostVersionRefusal

export type ManagedOrcadAutoUpdatePlan =
  | { action: 'update' }
  | { action: 'skip'; reason: ManagedOrcadAutoUpdateSkip }

export function planManagedOrcadAutoUpdate(input: {
  record: OrcadActivationRecord
  /** This app's bundled build for the host's target; null when the template lacks it. */
  candidateVersion: string | null
  appVersion: string
  /** An update to this app version already failed on this host. */
  failedBefore: boolean
}): ManagedOrcadAutoUpdatePlan {
  const { record, candidateVersion } = input
  if (!candidateVersion) {
    return { action: 'skip', reason: 'no-template' }
  }
  if (record.active === candidateVersion) {
    return { action: 'skip', reason: 'current' }
  }
  if (record.rolledBackFrom === candidateVersion) {
    return { action: 'skip', reason: 'rolled-back' }
  }
  const refusal = refuseOrcadHostDowngrade(record, candidateVersion, input.appVersion)
  if (refusal) {
    return { action: 'skip', reason: refusal }
  }
  // Why no `failedBefore` skip on a stopped host: nothing serves, so retrying is the only way back.
  if (record.active === null && record.previous !== null) {
    return { action: 'update' }
  }
  return input.failedBefore ? { action: 'skip', reason: 'failed-before' } : { action: 'update' }
}
