import { randomBytes } from 'node:crypto'
import type { WebSocket } from 'ws'
import type { DeviceEntry, DeviceRegistry } from '../device-registry'
import { isPendingTokenRow } from '../device-entry'
import { EPHEMERAL_DEVICE_SWEEP_INTERVAL_MS } from '../ephemeral-device-rows'
import {
  INSECURE_WEB_ORIGIN_AUTH_CODE,
  isInsecureRemoteWebOrigin
} from '../../../shared/web-origin-security'
import { devicePrincipalOf } from '../device-principal'
import type { E2EEKeypair } from '../e2ee-keypair'
import { resolveSocketDeviceKey } from './mobile-socket-device-key-resolution'
import { E2EEChannel, type E2EEAuthenticatedDevice } from './e2ee-channel'
import { createMobileE2EEOutboundMemoryBudget } from './mobile-e2ee-outbound-memory-budget'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { RpcBinarySender } from './rpc-binary-sender'
import type { E2EERedemptionOutcome, RedeemE2EETicket } from './e2ee-channel-redemption'
import type { E2EETicketRedemption } from './mobile-e2ee-auth-validation'

type MobileSocketPayload = string | Uint8Array<ArrayBufferLike>

export type MobileSocketTransportMetadata =
  // webClient: the Orca web bundle marked its upgrade; webOrigin: that page's origin.
  | { transport: 'direct'; webOrigin?: string; webClient?: true }
  | {
      transport: 'relay'
      relayHostId: string
      relayDeviceId: string
      basisConnId: string
      credentialKind: 'invite' | 'resume'
    }

export type MobileSocketTransport = {
  onMessage(
    handler: (
      message: MobileSocketPayload,
      reply: (response: string) => void,
      ws: WebSocket
    ) => void
  ): void
  onConnectionClose(
    handler: (clientId: string | null, ws: WebSocket, hasOtherConnections: boolean) => void
  ): void
  setClientId(ws: WebSocket, clientId: string): void
  terminateClientConnections(clientId: string): number
}

export type AuthenticatedMobileSocket = {
  ws: WebSocket
  connectionId: string
  device: E2EEAuthenticatedDevice
  // Why: a device-key registration proves possession over this exact connection.
  transcriptHashB64: string | null
  clientCapabilities: readonly RuntimeCapability[]
  transport: MobileSocketTransportMetadata
}

type MobileSocketWiringOptions = {
  deviceRegistry: DeviceRegistry
  e2eeKeypair: E2EEKeypair
  onText: (
    socket: AuthenticatedMobileSocket,
    plaintext: string,
    reply: (response: string) => void,
    sendBinary: RpcBinarySender
  ) => void
  onBinary: (socket: AuthenticatedMobileSocket, bytes: Uint8Array<ArrayBufferLike>) => void
  onClose: (socket: AuthenticatedMobileSocket | null, hasOtherConnections: boolean) => void
  onReady?: (socket: AuthenticatedMobileSocket) => void
  // Why: stale keys and missing registry entries both fail before RPC can explain the re-pair action.
  onUnpairedDeviceAuthFailure?: (metadata: MobileSocketTransportMetadata) => void
  // Operator opt-in for first pairings from a plain-http page on another machine.
  allowInsecureWebPairing?: () => boolean
  // Absent: this host does not redeem pairing tickets. Direct sockets only; relay ids are bound upstream.
  redeemTicket?: (
    redemption: E2EETicketRedemption,
    context: { transcriptHashB64: string; signal: AbortSignal }
  ) => Promise<E2EERedemptionOutcome<DeviceEntry>>
  // Why: a ticket's reserved id has no row until its redemption commits; "unknown" there is not a revocation.
  isReservedDeviceId?: (deviceId: string) => boolean
}

function toAuthenticatedDevice(device: DeviceEntry): E2EEAuthenticatedDevice {
  return {
    ...devicePrincipalOf(device),
    ...(device.token !== undefined ? { deviceToken: device.token } : {})
  }
}

export class MobileSocketWiring {
  private readonly deviceRegistry: DeviceRegistry
  private readonly e2eeKeypair: E2EEKeypair
  private readonly onText: MobileSocketWiringOptions['onText']
  private readonly onBinary: MobileSocketWiringOptions['onBinary']
  private readonly onClose: MobileSocketWiringOptions['onClose']
  private readonly onReady: MobileSocketWiringOptions['onReady']
  private readonly onUnpairedDeviceAuthFailure: MobileSocketWiringOptions['onUnpairedDeviceAuthFailure']
  private readonly allowInsecureWebPairing: () => boolean
  private readonly ephemeralSweep: ReturnType<typeof setInterval>
  private readonly redeemTicket: MobileSocketWiringOptions['redeemTicket']
  private readonly isReservedDeviceId: (deviceId: string) => boolean
  private readonly channels = new Map<WebSocket, E2EEChannel>()
  private readonly connectionIds = new Map<WebSocket, string>()
  private readonly authenticatedSockets = new Map<WebSocket, AuthenticatedMobileSocket>()
  private readonly transports = new Set<MobileSocketTransport>()
  private readonly outboundMemoryBudget = createMobileE2EEOutboundMemoryBudget()

  constructor(options: MobileSocketWiringOptions) {
    this.deviceRegistry = options.deviceRegistry
    this.e2eeKeypair = options.e2eeKeypair
    this.onText = options.onText
    this.onBinary = options.onBinary
    this.onClose = options.onClose
    this.onReady = options.onReady
    this.onUnpairedDeviceAuthFailure = options.onUnpairedDeviceAuthFailure
    this.allowInsecureWebPairing = options.allowInsecureWebPairing ?? (() => false)
    this.redeemTicket = options.redeemTicket
    this.isReservedDeviceId = options.isReservedDeviceId ?? (() => false)
    this.ephemeralSweep = setInterval(
      () => this.sweepIdleEphemeralDevices(Date.now()),
      EPHEMERAL_DEVICE_SWEEP_INTERVAL_MS
    )
    // Why: bookkeeping must never hold the process open.
    this.ephemeralSweep.unref?.()
  }

  dispose(): void {
    clearInterval(this.ephemeralSweep)
  }

  /** Removes idle session-only browser rows and cuts any socket still bound to them. */
  sweepIdleEphemeralDevices(now: number): string[] {
    let removed: string[] = []
    try {
      removed = this.deviceRegistry.pruneIdleEphemeralDevices(now, (deviceId) =>
        this.hasAuthenticatedSocket(deviceId)
      )
    } catch (error) {
      console.error('[mobile] Failed to prune idle browser-session devices:', error)
    }
    for (const deviceId of removed) {
      this.terminateDeviceConnections(deviceId)
    }
    return removed
  }

  private hasAuthenticatedSocket(deviceId: string): boolean {
    return Array.from(this.authenticatedSockets.values()).some(
      (socket) => socket.device.deviceId === deviceId
    )
  }

  attachTransport(
    transport: MobileSocketTransport,
    getMetadata: (ws: WebSocket) => MobileSocketTransportMetadata = () => ({
      transport: 'direct'
    })
  ): () => void {
    this.transports.add(transport)
    transport.onMessage((message, _reply, ws) => {
      this.handleRawMessage(transport, ws, message, getMetadata(ws))
    })
    transport.onConnectionClose((_clientId, ws) => this.handleClose(ws))
    let attached = true
    return () => {
      if (!attached) {
        return
      }
      attached = false
      this.transports.delete(transport)
    }
  }

  getConnectionId(ws: WebSocket): string | undefined {
    return this.connectionIds.get(ws)
  }

  get channelCount(): number {
    return this.channels.size
  }

  get connectionCount(): number {
    return this.connectionIds.size
  }

  terminateDeviceConnections(deviceId: string): number {
    let terminated = 0
    for (const transport of this.transports) {
      terminated += transport.terminateClientConnections(deviceId)
    }
    return terminated
  }

  private handleRawMessage(
    transport: MobileSocketTransport,
    ws: WebSocket,
    message: MobileSocketPayload,
    metadata: MobileSocketTransportMetadata
  ): void {
    let channel = this.channels.get(ws)
    if (!channel) {
      const connectionId = randomBytes(8).toString('hex')
      this.connectionIds.set(ws, connectionId)
      channel = new E2EEChannel(ws, {
        serverSecretKey: this.e2eeKeypair.secretKey,
        transportContext:
          metadata.transport === 'relay'
            ? { transport: 'relay', relayHostId: metadata.relayHostId }
            : { transport: 'direct' },
        requireV2: metadata.transport === 'relay',
        outboundMemoryBudget: this.outboundMemoryBudget,
        resolveAuthenticatedDevice: (token) => {
          const device = this.deviceRegistry.validateToken(token)
          if (!device) {
            return null
          }
          if (
            isPendingTokenRow(device) &&
            metadata.transport === 'direct' &&
            // Why the marker too: phones send an http Origin as well, and must never be gated.
            metadata.webClient === true &&
            isInsecureRemoteWebOrigin(metadata.webOrigin) &&
            !this.allowInsecureWebPairing()
          ) {
            return { refused: INSECURE_WEB_ORIGIN_AUTH_CODE }
          }
          // Why: outer relay authorization cannot choose the local Orca
          // identity; E2EE must resolve the same device before readiness.
          if (metadata.transport === 'relay' && metadata.relayDeviceId !== device.deviceId) {
            return null
          }
          return toAuthenticatedDevice(device)
        },
        resolveAuthenticatedDeviceKey: (deviceId) =>
          resolveSocketDeviceKey({
            registry: this.deviceRegistry,
            deviceId,
            metadata,
            isReservedDeviceId: this.isReservedDeviceId,
            toDevice: toAuthenticatedDevice
          }),
        redeemTicket: this.ticketRedeemerFor(metadata),
        onReady: (channel, device) => {
          const socket = {
            ws,
            connectionId,
            device,
            transcriptHashB64: channel.transcriptHashB64,
            // Why: the channel owns the set for the whole connection, so this reads
            // through rather than snapshotting. It must also WRITE through — the
            // capability RPC updates the socket, and a getter-only property makes
            // that a TypeError, which strands a capable phone with no capabilities.
            get clientCapabilities() {
              return channel.clientCapabilities
            },
            set clientCapabilities(next: readonly RuntimeCapability[]) {
              channel.clientCapabilities = next
            },
            transport: metadata
          }
          this.authenticatedSockets.set(ws, socket)
          transport.setClientId(ws, device.deviceId)
          // Why: deferred — the client's e2ee_authenticated must not wait on a secure-file rewrite.
          this.deviceRegistry.updateLastSeenDeferred(device.deviceId)
          this.onReady?.(socket)
        },
        onError: (code, reason) => {
          const reportUnpairedDevice = code === 4001 && reason === 'Unauthorized'
          this.channels.get(ws)?.destroy()
          this.channels.delete(ws)
          ws.close(code, reason)
          if (reportUnpairedDevice) {
            try {
              this.onUnpairedDeviceAuthFailure?.(metadata)
            } catch (error) {
              // Why: renderer teardown can make UI delivery throw; auth cleanup must remain authoritative.
              console.error('[mobile] Failed to report unpaired-device auth failure:', error)
            }
          }
        }
      })
      channel.onMessage((plaintext, reply, sendBinary) => {
        const socket = this.authenticatedSockets.get(ws)
        if (socket) {
          this.onText(socket, plaintext, reply, sendBinary)
        }
      })
      channel.onBinaryMessage((bytes) => {
        const socket = this.authenticatedSockets.get(ws)
        if (socket) {
          this.onBinary(socket, bytes)
        }
      })
      this.channels.set(ws, channel)
    }
    channel.handleRawMessage(message)
  }

  private ticketRedeemerFor(
    metadata: MobileSocketTransportMetadata
  ): RedeemE2EETicket<E2EEAuthenticatedDevice> | undefined {
    const redeemTicket = this.redeemTicket
    if (!redeemTicket || metadata.transport !== 'direct') {
      return undefined
    }
    return async (redemption, context) => {
      const outcome = await redeemTicket(redemption, context)
      return outcome.ok ? { ok: true, device: toAuthenticatedDevice(outcome.device) } : outcome
    }
  }

  private handleClose(ws: WebSocket): void {
    const socket = this.authenticatedSockets.get(ws) ?? null
    this.authenticatedSockets.delete(ws)
    this.channels.get(ws)?.destroy()
    this.channels.delete(ws)
    this.connectionIds.delete(ws)
    const hasOtherConnections =
      socket !== null &&
      Array.from(this.authenticatedSockets.values()).some(
        (candidate) => candidate.device.deviceId === socket.device.deviceId
      )
    // Why: a session-only row idles from its last disconnect, not from when it connected.
    if (socket && !hasOtherConnections && socket.device.deviceToken === undefined) {
      this.deviceRegistry.updateLastSeenDeferred(socket.device.deviceId)
    }
    this.onClose(socket, hasOtherConnections)
  }
}
