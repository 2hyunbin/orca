import type {
  PairedE2EEAuthReply,
  PairedE2EEClientHandshake
} from '../../../shared/paired-e2ee-client-handshake'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { resolveWebRuntimeAuthRejection } from './web-runtime-auth-verdict'
import {
  createWebRuntimeUnauthorizedError,
  type WebRuntimeAuthFailureReason,
  type WebRuntimeClientError
} from './web-runtime-client-error'
import {
  sealWebRuntimePlanAuth,
  type WebRuntimeConnectionState
} from './web-runtime-connection-frame-router'
import type { PairedRuntimeConnection } from '../../../shared/paired-runtime-connection'
import { WEB_PAIRED_E2EE_PRIMITIVES } from './web-paired-e2ee-primitives'
import { derivePairingComparisonCode } from '../../../shared/pairing-comparison-code-noble'
import {
  tokenOnlyCredentialSource,
  withWebRuntimeAuthPlan,
  withoutTokenOnKeyedSocket,
  type WebRuntimeAuthPlan,
  type WebRuntimeCredentialSource
} from './web-runtime-credential-source'
import { migrateWebRuntimeToDeviceKey } from './web-runtime-device-key-migration'

export type WebRuntimeConnectionLifecycle = {
  onStateChanged?: (state: WebRuntimeConnectionState) => void
  reconnect?: boolean
  credential?: WebRuntimeCredentialSource
  // Why: only the primary socket registers a key; helper sockets reuse it once active.
  allowKeyMigration?: boolean
  // The code to show while the desktop owner approves a ticket redemption.
  onPairingComparisonCode?: (code: string) => void
}

const HANDSHAKE_TIMEOUT_MS = 10_000
// Why: the desktop owner gets two minutes to approve a redemption, plus the durable write.
const REDEMPTION_HANDSHAKE_TIMEOUT_MS = 2 * 60_000 + 20_000

/** How one web transport authenticates each socket it opens (token, key, or a key migration). */
export class WebRuntimeConnectionAuth {
  plan: WebRuntimeAuthPlan | null = null
  private readyAccepted = false
  private failureReason: WebRuntimeAuthFailureReason = 'unauthorized'

  private readonly credential: WebRuntimeCredentialSource
  private readonly allowKeyMigration: boolean
  private readonly retryLater: () => void
  private readonly onPairingComparisonCode: ((code: string) => void) | undefined
  private verdictReceived = false

  constructor(
    connection: PairedRuntimeConnection,
    options: WebRuntimeConnectionLifecycle & {
      // No plan could be built (a migrated pairing whose key store is broken).
      retryLater: () => void
    }
  ) {
    // Why: an invalid host key fails construction, not the first connect.
    WEB_PAIRED_E2EE_PRIMITIVES.publicKeyFromBase64(connection.hostPublicKeyB64)
    const deviceToken = connection.credential.deviceToken
    this.retryLater = options.retryLater
    // Absent: the pairing token over legacy framing, as before device keys.
    this.credential = options.credential ?? tokenOnlyCredentialSource(deviceToken)
    this.allowKeyMigration = options.allowKeyMigration === true
    this.onPairingComparisonCode = options.onPairingComparisonCode
  }

  handshakeTimeoutMs(plan: WebRuntimeAuthPlan): number {
    return plan.kind === 'redeem' ? REDEMPTION_HANDSHAKE_TIMEOUT_MS : HANDSHAKE_TIMEOUT_MS
  }

  /** The socket authenticated; a ticket source then signs in with its key from now on. */
  authenticated(): void {
    this.verdictReceived = true
    if (this.plan) {
      this.credential.authenticated?.(this.plan)
    }
  }

  /** Resolves the next plan, then opens; synchronous for a token-only source. */
  open(openSocket: (plan: WebRuntimeAuthPlan) => void): void {
    withWebRuntimeAuthPlan(
      this.credential,
      this.allowKeyMigration,
      (plan) => {
        this.plan = plan
        this.readyAccepted = false
        this.verdictReceived = false
        openSocket(plan)
      },
      this.retryLater
    )
  }

  framingFor(plan: WebRuntimeAuthPlan): 'legacy' | 'v2' {
    return plan.kind === 'legacy-token' ? 'legacy' : 'v2'
  }

  async sendAuth(args: {
    handshake: PairedE2EEClientHandshake
    fallbackToken: string
    isCurrent: () => boolean
    send: (frame: string) => void
    fail: () => void
  }): Promise<void> {
    this.readyAccepted = true
    let frame: string
    try {
      frame = await sealWebRuntimePlanAuth(args.handshake, this.plan, args.fallbackToken)
    } catch {
      args.fail()
      return
    }
    if (!args.isCurrent()) {
      return
    }
    args.send(frame)
    const transcriptHashB64 = args.handshake.transcriptHashB64()
    if (this.plan?.kind === 'redeem' && transcriptHashB64) {
      this.onPairingComparisonCode?.(
        derivePairingComparisonCode(WEB_PAIRED_E2EE_PRIMITIVES.decodeBase64(transcriptHashB64))
      )
    }
  }

  outbound(message: unknown): unknown {
    return withoutTokenOnKeyedSocket(this.plan, message)
  }

  failureError(): WebRuntimeClientError {
    return createWebRuntimeUnauthorizedError(this.failureReason)
  }

  /** True when this socket is a key migration, which then reconnects instead of going live. */
  migrateIfPlanned(args: {
    handshake: PairedE2EEClientHandshake
    beginMigration: () => void
    call: (method: string, params?: unknown) => Promise<RuntimeRpcResponse<unknown>>
    reconnect: () => void
  }): boolean {
    const plan = this.plan
    if (plan?.kind !== 'migrate') {
      return false
    }
    args.beginMigration()
    void migrateWebRuntimeToDeviceKey({
      plan,
      transcriptHashB64: args.handshake.transcriptHashB64(),
      source: this.credential,
      call: args.call
    }).then(args.reconnect)
    return true
  }

  async rejected(
    reply: Extract<PairedE2EEAuthReply, { kind: 'rejected' }>
  ): Promise<{ kind: 'retry' } | { kind: 'failed'; error: WebRuntimeClientError }> {
    this.verdictReceived = true
    const outcome = await resolveWebRuntimeAuthRejection(this.plan, reply, this.credential)
    if (outcome.kind === 'retry') {
      return outcome
    }
    this.failureReason = outcome.reason
    return { kind: 'failed', error: this.failureError() }
  }

  socketClosed(): void {
    // Why: a host that refuses a v2 hello predates device keys; fall back to the token.
    if (this.plan?.kind === 'migrate' && !this.readyAccepted) {
      this.credential.migrationUnavailable()
    }
    // Why: the redemption may have committed before the reply was lost; sign in with the key first.
    if (this.plan?.kind === 'redeem' && this.readyAccepted && !this.verdictReceived) {
      this.credential.redemptionInterrupted?.()
    }
  }
}
