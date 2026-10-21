/**
 * The SSH connect's update decision on a WSL connect: a newer build, the one the host rolled back
 * from, or one already rejected this launch keeps the incumbent serving, adopted as an SSH first
 * deploy adopts it. The fenced activation applies the same plan again.
 */
import type { WslHostDeferredUpdate } from '../../shared/wsl-host-types'
import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcadActivationRecord } from '../managed-server/activation/orcad-activation-record'
import { readOrcadActivationRecord } from '../managed-server/activation/orcad-activation-record-store'
import { isWaitingOrcadUpdateDeferral } from '../managed-server/lifecycle/orcad-managed-auto-update'
import {
  orcadUpdateSkipRefusal,
  planManagedOrcadAutoUpdate,
  type ManagedOrcadAutoUpdatePlan
} from '../managed-server/lifecycle/orcad-managed-update-decision'
import {
  orcadUpdateFailureThisLaunch,
  recordOrcadUpdateFailedThisLaunch,
  type OrcadUpdateFailure,
  type OrcadUpdateFailureHost
} from '../managed-server/lifecycle/orcad-managed-update-failure-memory'
import { ORCAD_ACTIVATION_POLICY_REFUSED_CODE } from '../ssh/orcad-installed-activation'
import type { OrcadSlotOptions } from '../ssh/orcad-recovery-slot'
import { adoptRunningOrcadVersion } from '../ssh/orcad-running-version-adoption'

export type WslOrcadUpdateAdmission =
  | {
      action: 'serve'
      version: string
      readiness: ServeReadiness
      deferredUpdate: WslHostDeferredUpdate | null
    }
  /** Another run holds the host fence; a later connect adopts or deploys. */
  | { action: 'defer'; deferredUpdate: WslHostDeferredUpdate }
  /** Deploy this app's build on this record. */
  | { action: 'deploy'; record: OrcadActivationRecord }

export async function admitWslOrcadUpdate(args: {
  slot: OrcadSlotOptions
  record: OrcadActivationRecord
  candidateVersion: string
  appVersion: string
  host: OrcadUpdateFailureHost
  force?: boolean
}): Promise<WslOrcadUpdateAdmission> {
  const { record, candidateVersion, appVersion } = args
  if (!record.active || args.force) {
    return { action: 'deploy', record }
  }
  const failure = orcadUpdateFailureThisLaunch(args.host)
  const plan = planManagedOrcadAutoUpdate({
    record,
    candidateVersion,
    appVersion,
    failedBefore: failure !== null
  })
  if (plan.action !== 'skip' || plan.reason === 'current') {
    return { action: 'deploy', record }
  }
  const adopted = await adoptRunningOrcadVersion(args.slot, record, candidateVersion)
  if (!adopted) {
    // Nothing active any more: deploy on the record the wake read; its fenced admission re-plans.
    return { action: 'deploy', record: await readOrcadActivationRecord(args.slot) }
  }
  if ('outcome' in adopted) {
    const { candidateVersion: version, code, reason, forceable } = adopted
    return {
      action: 'defer',
      deferredUpdate: { candidateVersion: version, code, reason, forceable: forceable === true }
    }
  }
  return {
    action: 'serve',
    version: adopted.version,
    readiness: adopted.readiness,
    deferredUpdate:
      adopted.version === candidateVersion
        ? null
        : skippedUpdateHint(plan, failure, record, candidateVersion, appVersion)
  }
}

/**
 * Keeps Force, the one explicit retry, on a connect that skipped this app's build. A newer host
 * gets none: nothing this app carries would update it.
 */
function skippedUpdateHint(
  plan: ManagedOrcadAutoUpdatePlan,
  failure: OrcadUpdateFailure | null,
  record: OrcadActivationRecord,
  candidateVersion: string,
  appVersion: string
): WslHostDeferredUpdate | null {
  if (plan.action !== 'skip') {
    return null
  }
  if (plan.reason === 'failed-before' && failure) {
    return { candidateVersion, ...failure, forceable: true }
  }
  const refusal =
    plan.reason === 'rolled-back'
      ? orcadUpdateSkipRefusal(plan, record, candidateVersion, appVersion)
      : null
  return refusal
    ? {
        candidateVersion,
        code: ORCAD_ACTIVATION_POLICY_REFUSED_CODE,
        reason: refusal,
        forceable: true
      }
    : null
}

/**
 * As SSH's connect: an update over an incumbent that was rejected or threw is not retried this
 * launch. Null failures (a wait or a policy refusal) never tried it.
 */
export function recordWslOrcadUpdateFailure(
  host: OrcadUpdateFailureHost,
  incumbentVersion: string | null,
  failure: OrcadUpdateFailure | null
): void {
  if (incumbentVersion && failure) {
    recordOrcadUpdateFailedThisLaunch(host, failure)
  }
}

export function wslOrcadDeferralFailure(deployed: {
  code: string
  reason: string
}): OrcadUpdateFailure | null {
  return isWaitingOrcadUpdateDeferral(deployed.code) ||
    deployed.code === ORCAD_ACTIVATION_POLICY_REFUSED_CODE
    ? null
    : { code: deployed.code, reason: deployed.reason }
}
