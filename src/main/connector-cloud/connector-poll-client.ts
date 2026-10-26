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
  type ConnectorEvent,
  type ConnectorProject
} from '../../shared/connector-cloud-contract'
import type {
  ExternalConversationHost,
  ExternalConversationSeam
} from '../external-conversations/external-conversation-seam'
import { UNREADABLE_ANSWER, type ConnectorFailure } from './connector-cloud-request'
import { dispatchDelivery } from './connector-deliveries'
import type { ConnectorHostIdentity } from './connector-host-identity'
import { ConnectorHostSession } from './connector-host-session'
import {
  connectorRetryDelayMs,
  ConnectorSendQueue,
  type ConnectorBatchSender
} from './connector-send-queue'
import type { ConnectorTurnEvents } from './connector-turn-events'

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
  identity: ConnectorHostIdentity
  /** Owned by the caller across clients; this client only sends through it while running. */
  events: ConnectorTurnEvents
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
  readonly identity: ConnectorHostIdentity
  private readonly host: ExternalConversationHost
  private readonly session: ConnectorHostSession
  private readonly stopped = new AbortController()
  private readonly acks: ConnectorSendQueue<ConnectorAck>
  private readonly sendAcks: ConnectorBatchSender<ConnectorAck>
  private readonly sendEvents: ConnectorBatchSender<ConnectorEvent>
  // Received in this process and not yet confirmed done.
  private readonly active = new Set<string>()
  private readonly random: () => number
  private releaseWatch: (() => void) | null = null
  private helloRev = 0
  // What the cloud was last told; null makes the next cycle say hello.
  private helloSaid: string | null = null
  private failures = 0
  private stopReason: Stop | null = null

  constructor(private readonly options: ConnectorPollClientOptions) {
    this.seam = options.seam
    this.identity = options.identity
    this.random = options.random ?? Math.random
    this.host = options.machine.conversationHost()
    this.session = new ConnectorHostSession(
      options.origin,
      options.identity.keypair,
      options.fetchImpl
    )
    this.acks = new ConnectorSendQueue<ConnectorAck>({
      maxBatch: MAX_ACKS_PER_REQUEST,
      random: this.random,
      onAccepted: (sent) => {
        for (const ack of sent) {
          if (ack.step === 'done') {
            this.active.delete(ack.deliveryId)
          }
        }
      }
    })
    this.sendAcks = (acks) => this.post(CONNECTOR_PATHS.acks, { v: 1, acks })
    this.sendEvents = (events) => this.post(CONNECTOR_PATHS.events, { v: 1, events })
  }

  start(): void {
    // A disable disposes the seam; nothing here may outlive it.
    this.seam.signal.addEventListener('abort', () => this.stop(), {
      once: true,
      signal: this.stopped.signal
    })
    this.acks.attach(this.sendAcks)
    void this.run()
  }

  stop(): void {
    this.stopped.abort()
    // Confirmations still owed are listed as unsettled on the next session and settled from receipts.
    this.acks.detach(this.sendAcks)
    this.options.events.detach(this.sendEvents)
    this.releaseWatch?.()
    this.releaseWatch = null
  }

  private async run(): Promise<void> {
    while (!this.stopped.signal.aborted) {
      let stop: Stop | null
      try {
        stop = await this.cycle()
      } catch (error) {
        console.error('[connector] poll cycle failed', error)
        stop = await this.backoff(UNREADABLE_ANSWER)
      }
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
    const { machine } = this.options
    const said = { agents: machine.agents(), projects: machine.projects() }
    if (JSON.stringify(said) !== this.helloSaid) {
      const refused = await this.hello(said)
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
    // A stopped client admits nothing, even from an answer that arrived anyway.
    if (this.stopped.signal.aborted) {
      return null
    }
    if (!polled.ok) {
      // A new session must say hello first; forgetting what was said makes the next cycle say it.
      if (polled.status === 409) {
        this.helloSaid = null
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
    return this.obey(response.control)
  }

  /** Null once the cloud took it; otherwise why not. */
  private async hello(said: {
    agents: string[]
    projects: ConnectorProject[]
  }): Promise<ConnectorFailure | null> {
    const { machine, identity } = this.options
    // Monotonic across restarts, so the cloud never keeps an older process's hello.
    const helloRev = Math.max(this.helloRev + 1, Date.now())
    const answer = await this.session.call(
      CONNECTOR_PATHS.hello,
      {
        v: 1,
        helloRev,
        contract: CONNECTOR_CONTRACT_VERSION,
        orcaVersion: machine.orcaVersion,
        platform: process.platform,
        runtime: machine.runtime,
        hostName: identity.link.hostName,
        agents: said.agents,
        promptKinds: PROMPT_KINDS,
        features: FEATURES,
        projects: said.projects
      },
      z.unknown(),
      { method: 'PUT', signal: this.stopped.signal }
    )
    if (!answer.ok) {
      return answer
    }
    if (this.stopped.signal.aborted) {
      return null
    }
    this.helloRev = helloRev
    this.helloSaid = JSON.stringify(said)
    this.watchAgain()
    return null
  }

  /** Each hello opens a fresh watch, whose first event is the snapshot the cloud reconciles against. */
  private watchAgain(): void {
    const { events } = this.options
    events.newSession()
    const previous = this.releaseWatch
    this.releaseWatch = this.seam.watch(this.host, (event) => events.observe(event))
    previous?.()
    events.attach(this.sendEvents)
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
    if (this.stopped.signal.aborted) {
      return
    }
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
    await delayUnlessAborted(
      connectorRetryDelayMs(this.failures++, failure, this.random),
      this.stopped.signal
    )
    return null
  }

  private async post(path: string, body: unknown): Promise<ConnectorFailure | null> {
    const sent = await this.session.call(path, body, z.unknown(), { signal: this.stopped.signal })
    if (sent.ok) {
      return null
    }
    const stop = stopFor(sent)
    if (stop) {
      this.halt(stop)
    }
    return sent
  }

  /** Only a running client may stop for a reason; a retired one's late answers mean nothing. */
  private halt(reason: Stop): void {
    if (!this.stopped.signal.aborted) {
      this.stopReason = reason
      this.stop()
    }
  }
}
