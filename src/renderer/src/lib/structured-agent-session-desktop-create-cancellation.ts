import type { WorktreeCreationRequest } from './pending-worktree-creation'
import type { AgentLaunchCancelResult } from '../../../shared/agent-launch-cancellation'
import { recordHostCreatedLaunchMessage } from './structured-agent-session-host-launch-prompt'

import { runtimeRpcTargetForAuthorityKey } from '@/runtime/runtime-client-target'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision,
  isRuntimeEnvironmentContinuationPending
} from '@/runtime/runtime-environment-revision'

import {
  settleHostCreatedLaunchResult,
  discardStructuredLaunchPrompts
} from './structured-agent-session-launch-prompt'
import type { ExecutionHostId } from '../../../shared/execution-host'

import type { DesktopCreateLaunchRecord } from './structured-agent-session-launch-record'
import {
  deleteStructuredAgentLaunchRecord,
  markStructuredAgentLaunchCancelledPersisted,
  readStructuredAgentLaunchRecord
} from './structured-agent-session-launch-persistence'

import { notifyStructuredLaunchListeners } from './structured-agent-session-launch-registry'

import {
  currentDesktopCreate,
  removeDesktopCreateProvisional
} from './structured-agent-session-desktop-create-presentation'

/** Progress removal is synchronous; durable prevention never gates closing its view. */
export async function cancelDesktopCreateLaunch(
  launch: NonNullable<WorktreeCreationRequest['hostAgentLaunch']>
): Promise<void> {
  if (!launch.issued) {
    return
  }
  const record = readStructuredAgentLaunchRecord(launch.sessionId)
  if (!record?.desktopCreate || record.desktopCreate.params.operationId !== launch.operationId) {
    return
  }
  const target = launch.target
  const revision =
    target.kind === 'environment' && launch.pairingRevision !== undefined
      ? resolveContinuedRuntimeEnvironmentRevision(target.environmentId, launch.pairingRevision)
      : undefined
  const current = (): boolean =>
    Boolean(currentDesktopCreate(record)) &&
    (target.kind === 'local' ||
      (revision !== undefined &&
        getRuntimeEnvironmentRevision(target.environmentId) === revision &&
        launch.pairingRevision !== undefined &&
        !isRuntimeEnvironmentContinuationPending(target.environmentId, launch.pairingRevision)))
  if (!current()) {
    return
  }
  const result = await callRuntimeRpc<AgentLaunchCancelResult>(
    target,
    'agent.launchCancel',
    structuredClone(launch.params),
    {
      ...(target.kind === 'environment' ? { expectedEnvironmentPairingRevision: revision } : {}),
      beforeSend: () => {
        if (!current()) {
          throw new Error('agent_session_operation_unknown')
        }
      }
    }
  )
  if (!current()) {
    return
  }
  if (result.messageId) {
    recordHostCreatedLaunchMessage(record.sessionId, result.messageId)
  }
  if (result.status === 'cancelled') {
    discardStructuredLaunchPrompts(record.sessionId)
    deleteStructuredAgentLaunchRecord(record.sessionId)
    removeDesktopCreateProvisional(record)
    notifyStructuredLaunchListeners(false)
  } else if (result.result) {
    settleHostCreatedLaunchResult(record.sessionId, record.executionHostId, result.result)
  }
}

/** Explicit surface close abandons presentation now, independently of host prevention bookkeeping. */
export function cancelDesktopCreateOnClose(record: DesktopCreateLaunchRecord): void {
  const target = runtimeRpcTargetForAuthorityKey(record.executionHostId)
  if (!target) {
    return
  }
  const revision =
    target.kind === 'environment' ? getRuntimeEnvironmentRevision(target.environmentId) : undefined
  const current = (): boolean =>
    target.kind === 'local' ||
    (revision !== undefined &&
      getRuntimeEnvironmentRevision(target.environmentId) === revision &&
      !isRuntimeEnvironmentContinuationPending(target.environmentId, revision))
  if (!current()) {
    return
  }
  void callRuntimeRpc<AgentLaunchCancelResult>(
    target,
    'agent.launchCancel',
    structuredClone(record.desktopCreate.params),
    {
      ...(target.kind === 'environment' ? { expectedEnvironmentPairingRevision: revision } : {}),
      beforeSend: () => {
        if (!current()) {
          throw new Error('agent_session_operation_unknown')
        }
      }
    }
  ).catch((error: unknown) =>
    console.warn('[structured-agent-launch] closed surface cancellation unconfirmed', error)
  )
}

/** Explicit terminal close retires the same saved owner even after renderer restart. */
export function retireDesktopCreatePresentation(key: string, hostId?: ExecutionHostId): void {
  const record = readStructuredAgentLaunchRecord(key)
  if (!record?.desktopCreate || (hostId !== undefined && record.executionHostId !== hostId)) {
    return
  }
  markStructuredAgentLaunchCancelledPersisted(record.sessionId, record.executionHostId)
  discardStructuredLaunchPrompts(record.sessionId)
  cancelDesktopCreateOnClose(record)
  notifyStructuredLaunchListeners(false)
}
