// The machine side of the connector: one held poll, two confirmations per delivery, and turn events back.
import { z } from 'zod'
import { delayUnlessAborted } from '../../shared/abort-aware-delay'
import {
  CONNECTOR_CLIENT_LIMITS,
  CONNECTOR_CONTRACT_VERSION,
  CONNECTOR_PATHS,
  ConnectorDeliveryId,
  ConnectorPollControl,
  ConnectorPollResponse,
  type ConnectorAck,
  type ConnectorConversation,
  type ConnectorProject
} from '../../shared/connector-cloud-contract'
import type {
  ExternalConversationHost,
  ExternalConversationSeam
} from '../external-conversations/external-conversation-seam'
import type { ConnectorFailure } from './connector-cloud-request'
import { dispatchDelivery } from './connector-deliveries'
import type { ConnectorHostIdentity } from './connector-host-identity'
import { ConnectorHostSession } from './connector-host-session'
import { ConnectorSendQueue } from './connector-send-queue'
import { ConnectorTurnEvents } from './connector-turn-events'

const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const RECONNECT_SPREAD_MS = 2_000
const MAX_ACKS_PER_REQUEST = 100
// `reply` is advertised once `orca slack reply` ships.
const FEATURES = ['answer', 'cancel']
const PROMPT_KINDS = ['approval', 'question']

/** What the connector needs from this Orca; the seam exists exactly while connectors are on. */
export type ConnectorMachine = {
  runtime: 'serve' | 'desktop'
  orcaVersion: string
  seam: () => ExternalConversationSeam | null
  conversationHost: () => ExternalConversationHost
  agents: () => string[]
  projects: () => ConnectorProject[]
  onConnectorsToggled: (listener: () => void) => void
}

export type ConnectorPollClientOptions = {
  origin: string
  userDataPath: string
  identity: ConnectorHostIdentity
  seam: ExternalConversationSeam
  machine: ConnectorMachine
  /** The cloud no longer knows this key; the caller forgets it. */
  onRevoked: () => void
  fetchImpl?: typeof globalThis.fetch
  random?: () => number
}

type Stop = 'revoked' | 'too_old'

/** A refusal no retry can fix; any other failure is retried after a backoff. */
function stopFor(failure: ConnectorFailure): Stop | null {
  if (
    failure.status === 403 &&
    (failure.error === 'host_revoked' || failure.error === 'host_not_linked')
  ) {
    return 'revoked'
  }
  return failure.status === 426 ? 'too_old' : null
}

export class ConnectorPollClient {
  readonly seam: ExternalConversationSeam
  private readonly host: ExternalConversationHost
  private readonly session: ConnectorHostSession
  private readonly stopped = new AbortController()
  private readonly acks: ConnectorSendQueue<ConnectorAck>
  private readonly events: ConnectorTurnEvents
  // Received in this process and not yet confirmed done.
  private readonly active = new Set<string>()
  private readonly random: () => number
  private releaseWatch: (() => void) | null = null
  private helloRev = 0
  private helloProjects: string | null = null
  private failures = 0
  private stopReason: Stop | null = null

  constructor(private readonly options: ConnectorPollClientOptions) {
    this.seam = options.seam
    this.random = options.random ?? Math.random
    this.host = options.machine.conversationHost()
    this.session = new ConnectorHostSession(
      options.origin,
      options.identity.keypair,
      options.fetchImpl
    )
    this.acks = new ConnectorSendQueue((acks) => this.post(CONNECTOR_PATHS.acks, { v: 1, acks }), {
      maxBatch: MAX_ACKS_PER_REQUEST,
      onAccepted: (sent) => {
        for (const ack of sent) {
          if (ack.step === 'done') {
            this.active.delete(ack.deliveryId)
          }
        }
      }
    })
    this.events = new ConnectorTurnEvents(options.userDataPath, (events) =>
      this.post(CONNECTOR_PATHS.events, { v: 1, events })
    )
  }

  start(): void {
    // A disable disposes the seam; nothing here may outlive it.
    this.seam.signal.addEventListener('abort', () => this.stop(), { once: true })
    void this.run()
  }

  stop(): void {
    this.stopped.abort()
    this.releaseWatch?.()
    this.releaseWatch = null
  }

  private async run(): Promise<void> {
    while (!this.stopped.signal.aborted) {
      const stop = await this.cycle()
      if (stop) {
        this.halt(stop)
      }
    }
    if (this.stopReason === 'revoked') {
      console.warn('[connector] Orca Cloud no longer knows this machine; signed out.')
      this.options.onRevoked()
    } else if (this.stopReason === 'too_old') {
      console.warn('[connector] Orca Cloud needs a newer Orca; the connector stops until restart.')
    }
  }

  /** One hello-if-needed and one held poll; returns why to stop, or null to go on. */
  private async cycle(): Promise<Stop | null> {
    const projects = this.options.machine.projects()
    if (JSON.stringify(projects) !== this.helloProjects) {
      const refused = await this.hello(projects)
      if (refused) {
        return stopFor(refused) ?? this.backoff(refused)
      }
    }
    const sentAt = performance.now()
    const polled = await this.session.call(
      CONNECTOR_PATHS.poll,
      { v: 1, helloRev: this.helloRev },
      ConnectorPollResponse,
      { timeoutMs: CONNECTOR_CLIENT_LIMITS.pollTimeoutMs, signal: this.stopped.signal }
    )
    if (!polled.ok) {
      // A new session must say hello first; forgetting what was said makes the next cycle say it.
      if (polled.status === 409) {
        this.helloProjects = null
        return null
      }
      return stopFor(polled) ?? this.backoff(polled)
    }
    this.failures = 0
    const response = polled.value
    for (const unsettled of response.unsettled ?? []) {
      void this.reconcile(unsettled.deliveryId, unsettled.conversation)
    }
    // Network delay only shortens the deadline: it runs from when this poll was sent.
    const msLeft = (expiresAt: number): number =>
      expiresAt - response.serverNow - (performance.now() - sentAt)
    for (const raw of response.deliveries) {
      this.deliver(raw, msLeft)
    }
    void this.events.flush()
    void this.acks.flush()
    return this.obey(response.control)
  }

  /** Null once the cloud took it; otherwise why not. */
  private async hello(projects: ConnectorProject[]): Promise<ConnectorFailure | null> {
    const { machine, identity } = this.options
    // Monotonic across restarts, so the cloud never keeps an older process's hello.
    const helloRev = Math.max(this.helloRev + 1, Date.now())
    const said = await this.session.call(
      CONNECTOR_PATHS.hello,
      {
        v: 1,
        helloRev,
        contract: CONNECTOR_CONTRACT_VERSION,
        orcaVersion: machine.orcaVersion,
        platform: process.platform,
        runtime: machine.runtime,
        hostName: identity.link.hostName,
        agents: machine.agents(),
        promptKinds: PROMPT_KINDS,
        features: FEATURES,
        projects
      },
      z.unknown(),
      { method: 'PUT', signal: this.stopped.signal }
    )
    if (!said.ok) {
      return said
    }
    this.helloRev = helloRev
    this.helloProjects = JSON.stringify(projects)
    this.watchAgain()
    return null
  }

  /** Each hello opens a fresh watch, whose first event is the snapshot the cloud reconciles against. */
  private watchAgain(): void {
    this.events.newSession()
    const previous = this.releaseWatch
    this.releaseWatch = this.seam.watch(this.host, (event) => this.events.observe(event))
    previous?.()
  }

  private deliver(raw: unknown, msLeft: (expiresAt: number) => number): void {
    const id = ConnectorDeliveryId.safeParse(raw)
    // A lost `received` resends the delivery; this process already holds it.
    if (id.success && this.active.has(id.data.deliveryId)) {
      this.acks.push({ deliveryId: id.data.deliveryId, step: 'received' })
      return
    }
    const dispatched = dispatchDelivery(this.seam, this.host, raw, msLeft)
    if (!dispatched) {
      return
    }
    const { deliveryId, received, done } = dispatched
    this.active.add(deliveryId)
    if (received) {
      this.acks.push({ deliveryId, step: 'received' })
    }
    void done.then((result) => this.acks.push({ deliveryId, step: 'done', result }))
  }

  /** A delivery an earlier process received: replay its receipt, never run it again. */
  private async reconcile(deliveryId: string, conversation: ConnectorConversation): Promise<void> {
    if (this.active.has(deliveryId)) {
      return
    }
    this.active.add(deliveryId)
    const recorded = await this.seam.recorded(conversation, deliveryId)
    this.acks.push({
      deliveryId,
      step: 'done',
      result: recorded ?? { outcome: 'unknown', reason: 'no_local_record' }
    })
  }

  private async obey(raw: unknown): Promise<Stop | null> {
    const control = ConnectorPollControl.safeParse(raw)
    if (!control.success) {
      return null
    }
    if ('stop' in control.data) {
      return control.data.stop === 'client_too_old' ? 'too_old' : 'revoked'
    }
    const waitMs =
      'pausedForMs' in control.data ? control.data.pausedForMs : this.random() * RECONNECT_SPREAD_MS
    await delayUnlessAborted(waitMs, this.stopped.signal)
    return null
  }

  private async backoff(failure: ConnectorFailure): Promise<null> {
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.failures)
    this.failures++
    const waitMs = Math.max(failure.retryAfterMs ?? 0, ceiling * (0.5 + this.random() / 2))
    await delayUnlessAborted(waitMs, this.stopped.signal)
    // Confirmations refused during the outage go out again now.
    void this.acks.flush()
    void this.events.flush()
    return null
  }

  private async post(path: string, body: unknown): Promise<boolean> {
    if (this.stopped.signal.aborted) {
      return false
    }
    const sent = await this.session.call(path, body, z.unknown(), { signal: this.stopped.signal })
    const stop = sent.ok ? null : stopFor(sent)
    if (stop) {
      this.halt(stop)
    }
    return sent.ok
  }

  private halt(reason: Stop): void {
    this.stopReason ??= reason
    this.stop()
  }
}
