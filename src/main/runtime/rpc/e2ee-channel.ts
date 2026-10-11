// Why: this channel keeps E2EE framing out of RPC handlers, which consume plaintext across transports.
import type { WebSocket } from 'ws'
import { encrypt } from './e2ee-crypto'
import { handleDesktopMobileE2EELegacyInbound } from './mobile-e2ee-legacy-desktop-inbound'
import type {
  DesktopMobileE2EEV2Session,
  DesktopMobileE2EEV2Context
} from './mobile-e2ee-v2-desktop-session'
import type { DesktopMobileE2EEV2OutboundItem as V2OutboundItem } from './mobile-e2ee-v2-desktop-outbound'
import { handleDesktopMobileE2EEV2Inbound } from './mobile-e2ee-v2-desktop-inbound'
import { acceptE2EEHello } from './e2ee-channel-hello'
import {
  authenticateMobileE2EE,
  describeMobileE2EEAuthFailure,
  type DeviceKeyResolution,
  type DeviceTokenRefusal,
  type E2EETicketRedemption,
  type MobileE2EEAuthFailureCode
} from './mobile-e2ee-auth-validation'
import {
  PAIRING_TICKET_REDEMPTION_TIMEOUT_MS,
  startE2EERedemption,
  type RedeemE2EETicket
} from './e2ee-channel-redemption'
import { isMobileE2EEOutboundItemWithinLimit } from './mobile-e2ee-outbound-admission'
import type { MobileE2EEOutboundMemoryBudget } from './mobile-e2ee-outbound-memory-budget'
import { MobileE2EEDesktopOutboundOwner } from './mobile-e2ee-desktop-outbound-owner'
import { createLegacyReplySenders } from './mobile-e2ee-legacy-reply-senders'
import { parseRuntimeClientCapabilities } from './runtime-client-capabilities'
import type {
  RpcBinarySendOptions,
  RpcBinarySendResult,
  RpcBinarySender
} from './rpc-binary-sender'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { EventProps } from '../../../shared/telemetry-events'
import { track } from '../../telemetry/client'
import type { DevicePrincipal } from '../device-principal'

type OutboundBudgetEmitter = EventProps<'remote_outbound_budget_close'>['emitter']

const HANDSHAKE_TIMEOUT_MS = 10_000
const MAX_CONSECUTIVE_DECRYPT_FAILURES = 5

export type E2EEChannelOptions = {
  serverSecretKey: Uint8Array
  resolveAuthenticatedDevice: (token: string) => E2EEAuthenticatedDevice | DeviceTokenRefusal | null
  // Absent: key auth is refused as bad_auth, the same as before device keys existed.
  resolveAuthenticatedDeviceKey?: (deviceId: string) => DeviceKeyResolution<E2EEAuthenticatedDevice>
  // Absent: a ticket redemption is refused as bad_auth, as on hosts that predate tickets.
  redeemTicket?: RedeemE2EETicket<E2EEAuthenticatedDevice>
  onReady: (channel: E2EEChannel, device: E2EEAuthenticatedDevice) => void
  onError: (code: number, reason: string) => void
  transportContext?: DesktopMobileE2EEV2Context
  requireV2?: boolean
  outboundMemoryBudget?: MobileE2EEOutboundMemoryBudget
}

export type E2EEAuthenticatedDevice = DevicePrincipal & {
  // Absent for a keyed row, which never presented a bearer.
  deviceToken?: string
}

export class E2EEChannel {
  private state: 'awaiting_hello' | 'awaiting_auth' | 'redeeming' | 'ready' = 'awaiting_hello'
  private sharedKey: Uint8Array | null = null
  private consecutiveFailures = 0
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly ws: WebSocket
  private readonly serverSecretKey: Uint8Array
  private readonly resolvers: Pick<
    E2EEChannelOptions,
    'resolveAuthenticatedDevice' | 'resolveAuthenticatedDeviceKey' | 'redeemTicket'
  >
  private redemptionAbort: AbortController | null = null
  private readonly onReady: (channel: E2EEChannel, device: E2EEAuthenticatedDevice) => void
  private readonly onError: (code: number, reason: string) => void
  private readonly transportContext: DesktopMobileE2EEV2Context
  private readonly requireV2: boolean
  private readonly outbound: MobileE2EEDesktopOutboundOwner
  private v2Session: DesktopMobileE2EEV2Session | null = null
  // Why: the handler is set after readiness because its reply closure needs this channel's encryption state.
  private messageHandler:
    | ((
        plaintext: string,
        encryptedReply: (response: string) => void,
        encryptedBinaryReply: RpcBinarySender
      ) => void)
    | null = null
  private binaryMessageHandler: ((plaintext: Uint8Array<ArrayBufferLike>) => void) | null = null

  deviceToken: string | null = null

  /** The v2 transcript this socket authenticated under; null on legacy framing. */
  get transcriptHashB64(): string | null {
    return this.v2Session?.transcriptHashB64 ?? null
  }
  authenticatedDevice: E2EEAuthenticatedDevice | null = null
  clientCapabilities: readonly RuntimeCapability[] = []

  constructor(ws: WebSocket, options: E2EEChannelOptions) {
    this.ws = ws
    this.serverSecretKey = options.serverSecretKey
    this.resolvers = options
    this.onReady = options.onReady
    this.onError = options.onError
    this.transportContext = options.transportContext ?? { transport: 'direct' }
    this.requireV2 = options.requireV2 ?? false
    this.outbound = new MobileE2EEDesktopOutboundOwner(
      ws,
      () => Boolean(this.sharedKey),
      () => this.closeForOutboundBudget('queue'),
      options.outboundMemoryBudget
    )

    this.armHandshakeTimer(HANDSHAKE_TIMEOUT_MS)
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }

  private armHandshakeTimer(timeoutMs: number): void {
    this.clearHandshakeTimer()
    this.handshakeTimer = setTimeout(() => {
      this.onError(4002, 'E2EE handshake timeout')
    }, timeoutMs)
  }

  onMessage(
    handler: (
      plaintext: string,
      encryptedReply: (response: string) => void,
      encryptedBinaryReply: RpcBinarySender
    ) => void
  ): void {
    this.messageHandler = handler
  }

  onBinaryMessage(handler: (plaintext: Uint8Array<ArrayBufferLike>) => void): void {
    this.binaryMessageHandler = handler
  }

  handleRawMessage(raw: string | Uint8Array<ArrayBufferLike>): void {
    if (this.state === 'awaiting_hello') {
      if (typeof raw !== 'string') {
        this.onError(4001, 'Invalid handshake message')
        return
      }
      this.handleHello(raw)
      return
    }

    if (this.v2Session) {
      this.handleV2RawMessage(raw)
      return
    }
    const sharedKey = this.sharedKey
    if (!sharedKey) {
      return
    }
    handleDesktopMobileE2EELegacyInbound({
      sharedKey,
      raw,
      state: this.state,
      onDecryptFailure: () => this.trackDecryptFailure(),
      onDecryptSuccess: () => (this.consecutiveFailures = 0),
      onAuth: (plaintext) => this.handleAuth(plaintext),
      onText: (plaintext) => {
        const reply = createLegacyReplySenders({
          ws: this.ws,
          outbound: this.outbound,
          getSharedKey: () => this.sharedKey,
          onOversize: () => this.closeForOutboundBudget('size')
        })
        this.messageHandler?.(plaintext, reply.text, reply.binary)
      },
      onBinary: (plaintext) => this.binaryMessageHandler?.(plaintext),
      onProtocolError: () => this.onError(4001, 'Invalid binary message before authentication')
    })
  }

  private trackDecryptFailure(): void {
    // Why: a wrong key cannot recover on this socket; close so the client uses its bounded auth retry budget.
    if (this.state === 'awaiting_auth') {
      this.onError(4001, 'Unauthorized')
    } else if (++this.consecutiveFailures >= MAX_CONSECUTIVE_DECRYPT_FAILURES) {
      this.onError(4003, 'Too many decryption failures')
    }
  }

  private handleHello(raw: string): void {
    const accepted = acceptE2EEHello(raw, {
      serverSecretKey: this.serverSecretKey,
      transportContext: this.transportContext,
      requireV2: this.requireV2
    })
    if (accepted.kind === 'refused') {
      this.onError(4001, accepted.reason)
      return
    }
    if (accepted.kind === 'v2') {
      this.v2Session = accepted.session
    } else {
      this.sharedKey = accepted.sharedKey
    }
    this.state = 'awaiting_auth'
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(accepted.readyText)
    }
  }

  private handleAuth(plaintext: string): void {
    const authentication = authenticateMobileE2EE({
      plaintext,
      v2Session: this.v2Session,
      resolveDevice: this.resolvers.resolveAuthenticatedDevice,
      resolveDeviceKey: this.resolvers.resolveAuthenticatedDeviceKey,
      acceptsRedemption: this.resolvers.redeemTicket !== undefined
    })
    if (authentication.ok === 'redeem') {
      this.redeem(authentication.redemption)
    } else if (!authentication.ok) {
      this.failAuth(authentication)
    } else {
      this.completeAuth(authentication.device, authentication.clientCapabilities)
    }
  }

  // Why: the owner may take up to two minutes to approve, so the handshake timer is extended.
  private redeem(redemption: E2EETicketRedemption): void {
    const session = this.v2Session
    if (!session || !this.resolvers.redeemTicket) {
      return this.failAuth({ code: 'bad_auth' })
    }
    this.state = 'redeeming'
    this.armHandshakeTimer(PAIRING_TICKET_REDEMPTION_TIMEOUT_MS)
    this.redemptionAbort = startE2EERedemption(this.resolvers.redeemTicket, redemption, {
      transcriptHashB64: session.transcriptHashB64,
      onSettled: (outcome) => {
        this.redemptionAbort = null
        return outcome.ok
          ? this.completeAuth(outcome.device, redemption.clientCapabilities)
          : this.failAuth(outcome)
      }
    })
  }

  private failAuth(failure: { code: MobileE2EEAuthFailureCode; deviceId?: string }): void {
    const described = describeMobileE2EEAuthFailure(failure)
    this.sendEncryptedControl(described.sealedError)
    this.onError(4001, described.closeReason)
  }

  private completeAuth(authenticatedDevice: E2EEAuthenticatedDevice, capabilities: unknown): void {
    this.clientCapabilities = parseRuntimeClientCapabilities(capabilities)
    this.deviceToken = authenticatedDevice.deviceToken ?? null
    this.authenticatedDevice = authenticatedDevice
    this.state = 'ready'
    this.clearHandshakeTimer()

    // Why: transport-bound identity checks must complete before the peer sees
    // authentication success; relay sockets additionally bind this context to
    // their immutable relayDeviceId in the resolver.
    this.onReady(this, authenticatedDevice)
    this.sendEncryptedControl(
      this.v2Session
        ? {
            type: 'e2ee_authenticated',
            v: 2,
            transcriptHashB64: this.v2Session.transcriptHashB64
          }
        : { type: 'e2ee_authenticated' }
    )
  }

  private handleV2RawMessage(raw: string | Uint8Array<ArrayBufferLike>): void {
    handleDesktopMobileE2EEV2Inbound({
      session: this.v2Session!,
      raw,
      awaitingAuth: this.state === 'awaiting_auth',
      onDecryptFailure: () => this.trackDecryptFailure(),
      onDecryptSuccess: () => (this.consecutiveFailures = 0),
      onAuth: (plaintext) => this.handleAuth(plaintext),
      onBinary: (plaintext) => this.binaryMessageHandler?.(plaintext),
      onText: (plaintext) =>
        this.messageHandler?.(
          plaintext,
          (response) => this.enqueueV2({ kind: 'text', plaintext: response }),
          (response, options) => this.enqueueV2({ kind: 'binary', plaintext: response }, options)
        ),
      onProtocolError: () => this.onError(4001, 'Invalid binary message before authentication')
    })
  }

  private enqueueV2(item: V2OutboundItem, options?: RpcBinarySendOptions): RpcBinarySendResult {
    if (!this.v2Session || this.ws.readyState !== this.ws.OPEN) {
      return false
    }
    if (!isMobileE2EEOutboundItemWithinLimit(item)) {
      this.closeForOutboundBudget('size')
      return false
    }
    return this.outbound.enqueueV2(item, this.v2Session, options)
  }

  // Why: this close kills the whole remote session. `size` means a producer emitted something
  // too big and should fall to zero once producers cap themselves; `queue` means a backed-up link.
  private closeForOutboundBudget(emitter: OutboundBudgetEmitter): void {
    try {
      track('remote_outbound_budget_close', { emitter })
    } catch {
      // Telemetry is best-effort; closing the unsafe socket remains authoritative.
    }
    this.onError(1013, 'Outbound reply buffer overflow')
  }

  private sendEncryptedControl(message: unknown): void {
    if (this.v2Session) {
      this.enqueueV2({ kind: 'text', plaintext: JSON.stringify(message) })
    } else if (this.ws.readyState === this.ws.OPEN && this.sharedKey) {
      const frame = encrypt(JSON.stringify(message), this.sharedKey)
      this.outbound.sendLegacyFrame(frame)
    }
  }

  destroy(): void {
    this.redemptionAbort?.abort()
    this.redemptionAbort = null
    this.clearHandshakeTimer()
    this.sharedKey = null
    this.authenticatedDevice = null
    this.v2Session = null
    this.messageHandler = null
    this.binaryMessageHandler = null
    this.outbound.dispose()
  }
}
