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

/**
 * Why a host's orcad build may change, the same three for SSH and WSL: a connect applies the
 * skips below; an explicit Update retries what they skipped, still behind the terminal census;
 * Force also passes the census.
 */
export type OrcadUpdateIntent = 'connect' | 'update' | 'force'

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

export function planOrcadUpdateForIntent(
  intent: OrcadUpdateIntent,
  input: Parameters<typeof planManagedOrcadAutoUpdate>[0]
): ManagedOrcadAutoUpdatePlan {
  return intent === 'connect' ? planManagedOrcadAutoUpdate(input) : { action: 'update' }
}

/** Why a fenced activation refuses a build the plan skips; null when it may activate. */
export function orcadUpdateSkipRefusal(
  plan: ManagedOrcadAutoUpdatePlan,
  record: OrcadActivationRecord,
  candidateVersion: string,
  appVersion: string
): string | null {
  if (plan.action !== 'skip' || plan.reason === 'current') {
    return null
  }
  return plan.reason === 'rolled-back'
    ? `This host's server rolled back from ${candidateVersion}, so a connect does not activate ` +
        'it again; choose Update to retry it.'
    : `Orca ${record.activeAppVersion} last ran this host's server, newer than this ` +
        `Orca (${appVersion}). Update Orca to start it.`
}
