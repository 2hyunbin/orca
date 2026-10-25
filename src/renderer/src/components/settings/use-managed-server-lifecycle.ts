import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  ORCAD_RECOVERY_CHANGED_STATE_CODE,
  type OrcadManagedDeferral,
  type OrcadManagedRuntimeStatus
} from '../../../../shared/orcad-managed-runtime'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import { useMountedRef } from '@/hooks/useMountedRef'
import { managedServerOutcomeLabel } from './managed-server-copy'

export type ManagedServerAction =
  | 'update'
  | 'forceUpdate'
  | 'rollback'
  | 'recover'
  | 'restoreSnapshot'
  | 'stop'
  | 'cancelStop'
  | 'forget'

export type ManagedServerLifecycle = {
  status: OrcadManagedRuntimeStatus | null
  statusError: string | null
  recovery: OrcadManagedRuntimeStatus['recovery']
  busy: ManagedServerAction | 'status' | null
  confirmingStop: boolean
  confirmingForget: boolean
  confirmingRestore: boolean
  /** An Update deferred only by running terminals, which Update anyway restarts past. */
  confirmingForceUpdate: OrcadManagedDeferral | null
  setConfirmingForceUpdate: (value: OrcadManagedDeferral | null) => void
  setConfirmingStop: (value: boolean) => void
  setConfirmingForget: (value: boolean) => void
  setConfirmingRestore: (value: boolean) => void
  loadStatus: () => Promise<void>
  run: (action: ManagedServerAction) => Promise<void>
}

/** Turns a refusal or deferral into the one line the user acts on. */
// Why only this code: the daemon carries these terminals across; other deferrals would strand them.
const TERMINALS_RUNNING_DEFERRAL_CODE = 'orcad_update_terminals_running'

function forceableTerminalsDeferral(
  result: { outcome: string } | OrcadManagedDeferral
): OrcadManagedDeferral | null {
  return result.outcome === 'deferred' &&
    'code' in result &&
    result.forceable === true &&
    result.code === TERMINALS_RUNNING_DEFERRAL_CODE
    ? result
    : null
}

function outcomeMessage(result: Parameters<typeof managedServerOutcomeLabel>[0]): string | null {
  return result.outcome === 'deferred' ||
    result.outcome === 'refused' ||
    result.outcome === 'failed'
    ? managedServerOutcomeLabel(result)
    : null
}

/** Status and lifecycle actions for a server Orca deployed and owns over SSH. */
export function useManagedServerLifecycle({
  api,
  environment,
  onChanged
}: {
  api: ManagedOrcadPreloadApi
  environment: Pick<PublicKnownRuntimeEnvironment, 'id'>
  onChanged: () => void
}): ManagedServerLifecycle {
  const mountedRef = useMountedRef()
  const [status, setStatus] = useState<OrcadManagedRuntimeStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [busy, setBusy] = useState<ManagedServerAction | 'status' | null>(null)
  const [confirmingStop, setConfirmingStop] = useState(false)
  const [confirmingForget, setConfirmingForget] = useState(false)
  const [confirmingRestore, setConfirmingRestore] = useState(false)
  const [confirmingForceUpdate, setConfirmingForceUpdate] = useState<OrcadManagedDeferral | null>(
    null
  )

  const loadStatus = useCallback(async () => {
    setBusy('status')
    try {
      const next = await api.getStatus({ selector: environment.id })
      if (mountedRef.current) {
        setStatus(next)
        setStatusError(null)
      }
    } catch (error) {
      if (mountedRef.current) {
        setStatusError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (mountedRef.current) {
        setBusy(null)
      }
    }
  }, [api, environment.id, mountedRef])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const run = async (action: ManagedServerAction): Promise<void> => {
    setBusy(action)
    try {
      const selector = { selector: environment.id }
      const result =
        action === 'update' || action === 'forceUpdate'
          ? await api.update(action === 'forceUpdate' ? { ...selector, force: true } : selector)
          : action === 'rollback'
            ? await api.rollback(selector)
            : action === 'recover' || action === 'restoreSnapshot'
              ? await api.recover({
                  ...selector,
                  acceptChangedState: action === 'restoreSnapshot'
                })
              : action === 'stop'
                ? await api.stop(selector)
                : action === 'forget'
                  ? await api.forget(selector)
                  : await api.cancelStop(selector)
      const forceable = action === 'update' ? forceableTerminalsDeferral(result) : null
      const message = forceable ? null : outcomeMessage(result)
      if (mountedRef.current) {
        setConfirmingForceUpdate(forceable)
      }
      if (message) {
        toast.message(message)
      }
      if (
        mountedRef.current &&
        action === 'recover' &&
        result.outcome === 'refused' &&
        'code' in result &&
        result.code === ORCAD_RECOVERY_CHANGED_STATE_CODE
      ) {
        setConfirmingRestore(true)
      }
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) {
        setBusy(null)
      }
      void loadStatus()
    }
  }

  return {
    status,
    statusError,
    recovery: status?.recovery ?? null,
    busy,
    confirmingStop,
    confirmingForget,
    confirmingRestore,
    confirmingForceUpdate,
    setConfirmingForceUpdate,
    setConfirmingStop,
    setConfirmingForget,
    setConfirmingRestore,
    loadStatus,
    run
  }
}
