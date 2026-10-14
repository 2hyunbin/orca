import type { DeviceEntry } from './device-entry'
import { callerScopeOf } from './device-principal'
import { denyRpcMethodForCaller } from './rpc/rpc-caller-scope'
import type { RpcMethodPermission } from './rpc/rpc-method-permission'
import type { parseManagedWorkspaceRequest } from './managed-workspace-gateway-frames'

export function admitManagedWorkspaceRequest(
  device: DeviceEntry | null,
  request: ReturnType<typeof parseManagedWorkspaceRequest>,
  boundToken: string | undefined,
  permission: RpcMethodPermission | undefined
): { allowed: true; device: DeviceEntry } | { allowed: false } {
  if (
    !device ||
    !permission ||
    denyRpcMethodForCaller(callerScopeOf(device), request.method, permission) ||
    permission === 'pairing-admin' ||
    permission === 'device-self' ||
    request.method.startsWith('pairing.') ||
    (request.deviceToken !== undefined && request.deviceToken !== boundToken)
  ) {
    return { allowed: false }
  }
  return { allowed: true, device }
}
