import type { AuthenticatedMobileSocket } from './rpc/mobile-socket-wiring'
import type { ManagedWorkspaceChildSession } from './managed-workspace-child-session'
import type { RemoteRuntimePassthroughSocket } from '../../shared/remote-runtime-passthrough-socket'
import type { RuntimeDeviceGrant } from './rpc/rpc-method-permission'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import type {
  ManagedRuntimeGatewayRoute,
  ManagedRuntimeGatewayDescriptor
} from '../../shared/managed-runtime-gateway-contract'
import type { RuntimeCapability } from '../../shared/protocol-version'
import type { ManagedWorkspaceDiscoverySelector } from '../../shared/managed-workspace-discovery-contract'

export type ManagedWorkspaceRoute = Extract<ManagedRuntimeGatewayRoute, { kind: 'managed' }>
export type ManagedWorkspaceHost = {
  connection: PairedRuntimeConnection
  runtimeId: string
  isCurrent(): boolean
  close?(): void
}
export type ManagedWorkspaceHosts = {
  describe?(
    selector: ManagedWorkspaceDiscoverySelector,
    controllerRuntimeId: string
  ): Promise<ManagedRuntimeGatewayDescriptor>
  resolve(route: ManagedWorkspaceRoute): Promise<ManagedWorkspaceHost>
  onRetired(listener: (environmentId: string) => void): () => void
}
export type ManagedWorkspaceStatus = { runtimeId: string; capabilities: RuntimeCapability[] }

export type ManagedWorkspaceGatewayLink = {
  socket: AuthenticatedMobileSocket
  route: ManagedWorkspaceRoute
  host?: ManagedWorkspaceHost
  session?: ManagedWorkspaceChildSession
  outgoing?: RemoteRuntimePassthroughSocket
  pending: (() => void)[]
  pendingBytes: number
  terminalMultiplex: boolean
  grants: readonly RuntimeDeviceGrant[]
  pendingIds: Set<string>
  statusIds: Set<string>
}
