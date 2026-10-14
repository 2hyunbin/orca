import type { WebSocket } from 'ws'
import type { DeviceRegistry, DeviceEntry } from './device-registry'
import type { RpcMethodPermission } from './rpc/rpc-method-permission'
import { sameGrants } from './device-entry'
import { rejectNodeWebSocketConnection } from './rpc/node-websocket-lifecycle'
import type { AuthenticatedMobileSocket } from './rpc/mobile-socket-wiring'
import type { RpcBinarySender } from './rpc/rpc-binary-sender'
import type {
  ManagedWorkspaceHosts,
  ManagedWorkspaceRoute,
  ManagedWorkspaceGatewayLink as Link
} from './managed-workspace-gateway-contract'
import { createManagedWorkspaceGatewaySession } from './managed-workspace-child-session'
import { admitManagedWorkspaceRequest } from './managed-workspace-gateway-admission'
import type { ManagedWorkspaceDiscoverySelector } from '../../shared/managed-workspace-discovery-contract'
import {
  managedWorkspaceRequestFrame,
  managedWorkspaceBinaryFrame,
  parseManagedWorkspaceRequest,
  managedWorkspaceFailureFrame
} from './managed-workspace-gateway-frames'

const MAX_PENDING_BYTES = 1024 * 1024
const MAX_PENDING_FRAMES = 64
const MAX_PENDING_OPENS = 128

/** One encrypted child session per incoming socket; no request can fall through to root dispatch. */
export class ManagedWorkspaceGateway {
  private readonly links = new Map<WebSocket, Link>()
  private readonly stopRetirement: () => void
  private readonly retiringSessions = new Set<Promise<void>>()
  private disposed = false
  private pendingOpens = 0

  get supportsDiscovery(): boolean {
    return !this.disposed && this.options.hosts.describe !== undefined
  }

  describe(selector: ManagedWorkspaceDiscoverySelector, controllerRuntimeId: string) {
    if (!this.supportsDiscovery || !this.options.hosts.describe) {
      throw new Error('Managed workspace discovery is unavailable')
    }
    return this.options.hosts.describe(selector, controllerRuntimeId)
  }

  constructor(
    private readonly options: {
      hosts: ManagedWorkspaceHosts
      registry(): DeviceRegistry | null
      permission(method: string): RpcMethodPermission | undefined
    }
  ) {
    this.stopRetirement = options.hosts.onRetired((id) => {
      for (const link of this.links.values()) {
        if (link.route.environmentId === id) {
          this.end(link)
        }
      }
    })
  }

  text(
    socket: AuthenticatedMobileSocket,
    route: ManagedWorkspaceRoute,
    plaintext: string,
    reply: (frame: string) => void,
    binary: RpcBinarySender
  ): void {
    let request: ReturnType<typeof parseManagedWorkspaceRequest>
    if (this.disposed) {
      socket.ws.terminate()
      return
    }
    try {
      request = parseManagedWorkspaceRequest(plaintext)
    } catch {
      socket.ws.terminate()
      return
    }
    const admission = admitManagedWorkspaceRequest(
      this.principal(socket),
      request,
      socket.device.clientId,
      this.options.permission(request.method)
    )
    if (!admission.allowed) {
      reply(
        managedWorkspaceFailureFrame(
          request.id,
          'forbidden',
          'This session cannot invoke that managed-server method'
        )
      )
      return
    }
    const link = this.link(socket, route, reply, binary, admission.device)
    if (!link) {
      return
    }
    if (request.method === 'status.get') {
      if (link.statusIds.size >= 256) {
        return this.end(link)
      }
      link.statusIds.add(request.id)
    }
    if (!link.outgoing) {
      link.pendingIds.add(request.id)
    }
    if (request.method === 'terminal.multiplex') {
      link.terminalMultiplex = true
    }
    this.enqueue(link, Buffer.byteLength(plaintext), () => {
      link.pendingIds.delete(request.id)
      const session = link.session
      if (!session || !link.outgoing || !this.current(link)) {
        return this.end(link)
      }
      const frame = managedWorkspaceRequestFrame(request, socket.device.clientId, session.clientId)
      if (!link.outgoing.send(frame)) {
        this.end(link)
      }
    })
  }

  binary(socket: AuthenticatedMobileSocket, bytes: Uint8Array<ArrayBufferLike>): void {
    const link = this.links.get(socket.ws)
    if (!link || !this.current(link)) {
      return socket.ws.terminate()
    }
    this.enqueue(link, bytes.byteLength, () => {
      if (!link.session || !link.outgoing || !this.current(link)) {
        return this.end(link)
      }
      try {
        const frame = link.terminalMultiplex
          ? managedWorkspaceBinaryFrame(bytes, socket.device.clientId, link.session.clientId)
          : bytes
        if (!link.outgoing.sendBinary(frame)) {
          this.end(link)
        }
      } catch {
        this.end(link)
      }
    })
  }

  close(socket: WebSocket): void {
    const link = this.links.get(socket)
    if (link) {
      this.end(link, false)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.stopRetirement()
    for (const link of this.links.values()) {
      this.end(link)
    }
    await Promise.all(this.retiringSessions)
  }

  private principal(socket: AuthenticatedMobileSocket): DeviceEntry | null {
    const device = this.options.registry()?.resolveAuthenticatedPrincipal(socket.device)
    return device?.scope === 'runtime' && !device.runtimeLease ? device : null
  }

  private current(link: Link): boolean {
    const principal = this.principal(link.socket)
    return (
      !this.disposed &&
      this.links.get(link.socket.ws) === link &&
      link.socket.ws.readyState === link.socket.ws.OPEN &&
      principal !== null &&
      sameGrants(principal, link.grants) &&
      (!link.host || link.host.isCurrent())
    )
  }

  private link(
    socket: AuthenticatedMobileSocket,
    route: ManagedWorkspaceRoute,
    reply: (frame: string) => void,
    binary: RpcBinarySender,
    device: DeviceEntry
  ): Link | null {
    const existing = this.links.get(socket.ws)
    if (existing) {
      return existing
    }
    if (this.pendingOpens >= MAX_PENDING_OPENS) {
      rejectNodeWebSocketConnection(
        socket.ws,
        1013,
        'Managed workspace connection capacity reached'
      )
      return null
    }
    const link: Link = {
      socket,
      route,
      pending: [],
      pendingBytes: 0,
      terminalMultiplex: false,
      grants: [...(device.grants ?? [])],
      pendingIds: new Set(),
      statusIds: new Set()
    }
    this.links.set(socket.ws, link)
    this.pendingOpens++
    void this.open(link, reply, binary, device)
      .catch(() => {
        if (!this.current(link)) {
          return this.end(link)
        }
        for (const id of link.pendingIds) {
          reply(
            managedWorkspaceFailureFrame(
              id,
              'remote_runtime_unavailable',
              'Could not open the managed workspace. Reconnect or update its server and try again.'
            )
          )
        }
        this.end(link, false)
        rejectNodeWebSocketConnection(socket.ws, 1011, 'Managed workspace unavailable')
      })
      .finally(() => {
        this.pendingOpens--
      })
    return link
  }

  private async open(
    link: Link,
    reply: (frame: string) => void,
    binary: RpcBinarySender,
    device: DeviceEntry
  ): Promise<void> {
    const host = await this.options.hosts.resolve(link.route)
    link.host = host
    if (!this.current(link)) {
      host.close?.()
      return this.end(link)
    }
    const session = createManagedWorkspaceGatewaySession({
      host,
      link,
      device,
      isCurrent: () => this.current(link),
      end: () => this.end(link),
      reply,
      binary
    })
    link.session = session
    link.outgoing = await session.open()
    if (!this.current(link)) {
      return this.end(link)
    }
    const pending = link.pending.splice(0)
    link.pendingBytes = 0
    for (const send of pending) {
      if (!this.current(link)) {
        break
      }
      send()
    }
  }

  private enqueue(link: Link, bytes: number, send: () => void): void {
    if (!this.current(link)) {
      return this.end(link)
    }
    if (link.outgoing) {
      return send()
    }
    if (
      link.pending.length >= MAX_PENDING_FRAMES ||
      link.pendingBytes + bytes > MAX_PENDING_BYTES
    ) {
      this.end(link)
      return
    }
    link.pending.push(send)
    link.pendingBytes += bytes
  }

  private end(link: Link, terminate = true): void {
    if (this.links.get(link.socket.ws) !== link) {
      return
    }
    this.links.delete(link.socket.ws)
    link.pending.length = 0
    link.pendingIds.clear()
    link.statusIds.clear()
    link.pendingBytes = 0
    link.session?.close()
    link.host?.close?.()
    if (link.session) {
      const drained = link.session.drain()
      this.retiringSessions.add(drained)
      void drained.finally(() => this.retiringSessions.delete(drained))
    }
    if (terminate) {
      link.socket.ws.terminate()
    }
  }
}
