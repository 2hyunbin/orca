import type { WorkspaceCreatorProvenance } from '../../../shared/worktree/types'
import type { RpcContext } from './core'

export function resolveRpcWorkspaceCreatorProvenance(
  context: Pick<
    RpcContext,
    'pairedDeviceId' | 'pairedDeviceParentId' | 'clientId' | 'clientKind' | 'connectionId'
  >
): WorkspaceCreatorProvenance {
  if (context.pairedDeviceId) {
    if (context.clientKind !== 'mobile') {
      return { kind: 'paired-device', deviceId: context.pairedDeviceId }
    }
    // Why: a phone acts for whoever paired it, so "Hide other-client workspaces" keeps its rows.
    return {
      kind: 'paired-device',
      deviceId: context.pairedDeviceId,
      onBehalfOf: context.pairedDeviceParentId
        ? { kind: 'paired-device', deviceId: context.pairedDeviceParentId }
        : { kind: 'host' }
    }
  }
  if (context.clientId || context.clientKind || context.connectionId) {
    throw new Error('authenticated_device_identity_missing')
  }
  return { kind: 'host' }
}
