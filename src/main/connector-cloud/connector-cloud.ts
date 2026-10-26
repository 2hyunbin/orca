// This Orca's link to the Orca Cloud connector: device-code sign-in, status and sign-out.
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import nacl from 'tweetnacl'
import { z } from 'zod'
import { delayUnlessAborted } from '../../shared/abort-aware-delay'
import {
  CONNECTOR_PATHS,
  ConnectorSignInPollResponse,
  ConnectorSignInStartResponse
} from '../../shared/connector-cloud-contract'
import { requestConnector } from './connector-cloud-request'
import {
  connectorHostId,
  deleteConnectorHostIdentity,
  keypairFromSecret,
  readConnectorHostIdentity,
  writeConnectorHostIdentity,
  type ConnectorHostLink
} from './connector-host-identity'
import { ConnectorHostSession } from './connector-host-session'
import { ConnectorPollClient, type ConnectorMachine } from './connector-poll-client'
import { ConnectorTurnEvents } from './connector-turn-events'
import type { E2EEKeypair } from '../runtime/e2ee-keypair'

// Sign-out still succeeds offline: once the key is gone nobody can act as this machine.
const SIGN_OUT_UNBIND_TIMEOUT_MS = 5_000

export type ConnectorCloudStatus = {
  enabled: boolean
  link: ConnectorHostLink | null
  /** Orca Cloud revoked this machine since this Orca started. */
  revoked: boolean
}

export type ConnectorSignInPrompt = {
  flowId: string
  userCode: string
  verificationUri: string
  expiresAt: number
}

type StartedSignIn = {
  keypair: E2EEKeypair
  hostName: string
  deviceCode: string
  expiresAt: number
  intervalMs: number
  prompt: Omit<ConnectorSignInPrompt, 'flowId'>
}

/** One sign-in from its start request to the key write; aborting `ended` retires every step. */
type SignInFlow = { id: string; ended: AbortController; started: Promise<StartedSignIn> }

const CANCELLED = 'Sign-in was cancelled.'

export type ConnectorCloudOptions = {
  userDataPath: string
  origin: string
  machine: ConnectorMachine
  fetchImpl?: typeof globalThis.fetch
  now?: () => number
}

export class ConnectorCloud {
  private flow: SignInFlow | null = null
  private client: ConnectorPollClient | null = null
  // Built on connect, so the outbox file is read once and has one owner for this process.
  private events: ConnectorTurnEvents | null = null
  private revoked = false
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => number

  constructor(private readonly options: ConnectorCloudOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? Date.now
  }

  status(): ConnectorCloudStatus {
    return {
      enabled: this.options.machine.seam() !== null,
      link: readConnectorHostIdentity(this.options.userDataPath)?.link ?? null,
      revoked: this.revoked
    }
  }

  /** From now on, hold the poll whenever connectors are on and this machine is linked. */
  connect(): void {
    if (this.events) {
      return
    }
    this.events = new ConnectorTurnEvents(this.options.userDataPath)
    this.options.machine.onConnectorsToggled(() => this.reconcile())
    this.reconcile()
  }

  private reconcile(): void {
    const { events } = this
    if (!events) {
      return
    }
    const seam = this.options.machine.seam()
    const identity = seam ? readConnectorHostIdentity(this.options.userDataPath) : null
    const current = this.client
    if (
      current &&
      (current.seam !== seam || current.identity.link.hostId !== identity?.link.hostId)
    ) {
      current.stop()
      this.client = null
    }
    if (!this.client && seam && identity) {
      const client = new ConnectorPollClient({
        origin: this.options.origin,
        identity,
        events,
        seam,
        machine: this.options.machine,
        // Only for the client still running; a retired one cannot sign out its replacement.
        onRevoked: () => {
          if (this.client === client) {
            this.forget({ revoked: true })
          }
        },
        fetchImpl: this.fetchImpl
      })
      this.client = client
      client.start()
    }
  }

  /** Stops the client and deletes the key and pending turn ends, which no other key can send. */
  private forget({ revoked }: { revoked: boolean }): void {
    this.client?.stop()
    this.client = null
    deleteConnectorHostIdentity(this.options.userDataPath)
    if (this.events) {
      this.events.clear()
    } else {
      ConnectorTurnEvents.clearStored(this.options.userDataPath)
    }
    this.revoked = revoked
  }

  /** Starts a sign-in the person approves in a browser by typing the code; a newer one replaces it. */
  async beginSignIn(name?: string): Promise<ConnectorSignInPrompt> {
    this.requireSignInAllowed()
    this.flow?.ended.abort()
    const ended = new AbortController()
    const flow: SignInFlow = {
      id: randomUUID(),
      ended,
      started: this.startSignIn(name?.trim() || hostname(), ended.signal)
    }
    this.flow = flow
    try {
      const { prompt } = await flow.started
      return { flowId: flow.id, ...prompt }
    } catch (error) {
      this.endFlow(flow)
      throw error
    }
  }

  /** Waits for the browser approval; the caller going away, a newer sign-in or a logout cancels it. */
  async finishSignIn(flowId: string, signal?: AbortSignal): Promise<ConnectorHostLink> {
    const flow = this.flow
    if (flow?.id !== flowId) {
      throw new Error('This sign-in is no longer running. Run `orca cloud login` again.')
    }
    const ended = signal ? AbortSignal.any([flow.ended.signal, signal]) : flow.ended.signal
    try {
      return await this.pollSignIn(await flow.started, ended)
    } finally {
      this.endFlow(flow)
    }
  }

  private requireSignInAllowed(): void {
    if (!this.options.machine.seam()) {
      throw new Error('connectors_disabled')
    }
    const linked = readConnectorHostIdentity(this.options.userDataPath)?.link
    if (linked) {
      throw new Error(
        `Already connected as ${linked.email} on ${linked.hostName}. Run \`orca cloud logout\` first.`
      )
    }
  }

  private requireCurrent(flow: StartedSignIn, ended: AbortSignal): void {
    if (ended.aborted) {
      throw new Error(CANCELLED)
    }
    this.requireSignInAllowed()
    if (this.now() >= flow.expiresAt) {
      throw new Error('Sign-in expired. Run `orca cloud login` again.')
    }
  }

  private endFlow(flow: SignInFlow): void {
    flow.ended.abort()
    if (this.flow === flow) {
      this.flow = null
    }
  }

  private async startSignIn(hostName: string, ended: AbortSignal): Promise<StartedSignIn> {
    // Every sign-in links a fresh key, so a key is never moved between accounts.
    const keypair = keypairFromSecret(nacl.box.keyPair().secretKey)
    const started = await requestConnector(
      {
        fetchImpl: this.fetchImpl,
        url: `${this.options.origin}${CONNECTOR_PATHS.signInStart}`,
        body: {
          v: 1,
          hostPublicKeyB64: keypair.publicKeyB64,
          hostName,
          platform: process.platform,
          runtime: this.options.machine.runtime,
          orcaVersion: this.options.machine.orcaVersion
        },
        signal: ended
      },
      ConnectorSignInStartResponse
    )
    if (ended.aborted) {
      throw new Error(CANCELLED)
    }
    this.requireSignInAllowed()
    if (!started.ok) {
      throw new Error(
        started.status === 404
          ? 'This Orca Cloud does not support server sign-in yet.'
          : started.status === 429
            ? 'Too many sign-in requests from this network. Try again in a few minutes.'
            : 'Could not reach Orca Cloud. Try again.'
      )
    }
    const { deviceCode, userCode, verificationUri, expiresAt, interval } = started.value
    return {
      keypair,
      hostName,
      deviceCode,
      expiresAt,
      intervalMs: interval * 1000,
      prompt: { userCode, verificationUri, expiresAt }
    }
  }

  private async pollSignIn(flow: StartedSignIn, ended: AbortSignal): Promise<ConnectorHostLink> {
    const hostId = connectorHostId(flow.keypair)
    let intervalMs = flow.intervalMs
    for (;;) {
      await delayUnlessAborted(intervalMs, ended)
      this.requireCurrent(flow, ended)
      const polled = await requestConnector(
        {
          fetchImpl: this.fetchImpl,
          url: `${this.options.origin}${CONNECTOR_PATHS.signInPoll}`,
          body: { v: 1, deviceCode: flow.deviceCode },
          signal: ended
        },
        ConnectorSignInPollResponse
      )
      // Checked again after the answer, so nothing retired meanwhile can still link a key.
      this.requireCurrent(flow, ended)
      // Lost answers and outages wait out the interval; the poll carries no secret to lose.
      if (!polled.ok) {
        continue
      }
      const answer = polled.value
      intervalMs = answer.interval * 1000
      if (answer.status === 'denied') {
        throw new Error('Sign-in was denied.')
      }
      if (answer.status === 'expired') {
        throw new Error('Sign-in expired. Run `orca cloud login` again.')
      }
      if (answer.status === 'authorized') {
        if (answer.hostId !== hostId) {
          throw new Error(
            'Orca Cloud linked a different machine key. Run `orca cloud login` again.'
          )
        }
        const link = {
          hostId,
          email: answer.account.email,
          hostName: flow.hostName,
          linkedAt: this.now()
        }
        writeConnectorHostIdentity(this.options.userDataPath, { keypair: flow.keypair, link })
        this.revoked = false
        this.reconcile()
        return link
      }
    }
  }

  /** Forgets the key, then unlinks it in the cloud when the cloud answers. */
  async signOut(): Promise<{ signedOut: boolean }> {
    if (this.flow) {
      this.endFlow(this.flow)
    }
    const identity = readConnectorHostIdentity(this.options.userDataPath)
    if (!identity) {
      return { signedOut: false }
    }
    // Forgotten before the unlink is sent, so nothing can reconnect with this key meanwhile.
    this.forget({ revoked: false })
    const session = new ConnectorHostSession(
      this.options.origin,
      identity.keypair,
      this.fetchImpl,
      this.now
    )
    const giveUp = AbortSignal.timeout(SIGN_OUT_UNBIND_TIMEOUT_MS)
    await Promise.race([
      session.call(CONNECTOR_PATHS.signOut, { v: 1 }, z.unknown(), { signal: giveUp }),
      delayUnlessAborted(SIGN_OUT_UNBIND_TIMEOUT_MS, giveUp)
    ])
    return { signedOut: true }
  }
}
