import { RUNTIME_AUTOMATIC_WORK_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { AutomaticWorkMode } from '../../../shared/host-spawn-admission'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { runtimeTargetForOwnerEnvironment } from './runtime-client-target'

export type AutomaticRestorePauseReason = Extract<AutomaticWorkMode, { kind: 'paused' }>['reason']

/** A current host report, not a receipt for the pane's original restore attempt. */
export async function observeHostAutomaticRestorePause(
  environmentId: string | null
): Promise<AutomaticRestorePauseReason | null> {
  try {
    const result = await callRuntimeRpc<unknown>(
      runtimeTargetForOwnerEnvironment(environmentId),
      'runtime.automaticWork.status',
      undefined,
      { timeoutMs: 10_000 }
    )
    if (!result || typeof result !== 'object' || !('automaticWork' in result)) {
      return null
    }
    const status = result.automaticWork
    if (!status || typeof status !== 'object' || !('mode' in status)) {
      return null
    }
    const mode = status.mode
    if (!mode || typeof mode !== 'object' || !('kind' in mode) || mode.kind !== 'paused') {
      return null
    }
    if (!('reason' in mode)) {
      return null
    }
    return mode.reason === 'unclean_host_death' ||
      mode.reason === 'pressure' ||
      mode.reason === 'operator'
      ? mode.reason
      : null
  } catch {
    return null
  }
}

/** Whether the host that owns a pane can clear a recorded pause; this app always can. */
export async function canResumeHostAutomaticRestores(
  environmentId: string | null
): Promise<boolean> {
  if (!environmentId) {
    return true
  }
  try {
    return await runtimeEnvironmentSupportsCapability(
      environmentId,
      RUNTIME_AUTOMATIC_WORK_RUNTIME_CAPABILITY
    )
  } catch {
    return false
  }
}

/** Clears the host's automatic-restore pause; sleeping panes still resume one by one. */
export async function resumeHostAutomaticRestores(environmentId: string | null): Promise<void> {
  await callRuntimeRpc(
    runtimeTargetForOwnerEnvironment(environmentId),
    'runtime.automaticWork.resume'
  )
}
