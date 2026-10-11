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
import { sealWebRuntimePlanAuth } from './web-runtime-connection-frame-router'
import {
  tokenOnlyCredentialSource,
  withWebRuntimeAuthPlan,
  withoutTokenOnKeyedSocket,
  type WebRuntimeAuthPlan,
  type WebRuntimeCredentialSource
} from './web-runtime-credential-source'
import { migrateWebRuntimeToDeviceKey } from './web-runtime-device-key-migration'

/** How one web transport authenticates each socket it opens (token, key, or a key migration). */
export class WebRuntimeConnectionAuth {
  plan: WebRuntimeAuthPlan | null = null
  private readyAccepted = false
  private failureReason: WebRuntimeAuthFailureReason = 'unauthorized'

  private readonly credential: WebRuntimeCredentialSource
  private readonly allowKeyMigration: boolean

  constructor(
    deviceToken: string,
    options: { credential?: WebRuntimeCredentialSource; allowKeyMigration?: boolean }
  ) {
    // Absent: the pairing token over legacy framing, as before device keys.
    this.credential = options.credential ?? tokenOnlyCredentialSource(deviceToken)
    this.allowKeyMigration = options.allowKeyMigration === true
  }

  /** Resolves the next plan, then opens; synchronous for a token-only source. */
  open(openSocket: (plan: WebRuntimeAuthPlan) => void): void {
    withWebRuntimeAuthPlan(this.credential, this.allowKeyMigration, (plan) => {
      this.plan = plan
      this.readyAccepted = false
      openSocket(plan)
    })
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
    if (args.isCurrent()) {
      args.send(frame)
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
  }
}
