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
  type ConnectorDeliveryResult,
  type ConnectorEvent,
  type ConnectorProject
} from '../../shared/connector-cloud-contract'
import type {
  ExternalConversationHost,
  ExternalConversationSeam
} from '../external-conversations/external-conversation-seam'
import { UNREADABLE_ANSWER, type ConnectorFailure } from './connector-cloud-request'
import { dispatchDelivery } from './connector-deliveries'
import type { ConnectorMachine, ConnectorTransport } from './connector-machine'
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

export type ConnectorPollClientOptions = {
  transport: ConnectorTransport
  /** Owned by the caller across clients; this client only sends through it while running. */
  events: ConnectorTurnEvents
  seam: ExternalConversationSeam
  machine: ConnectorMachine
  random?: () => number
}

/** Why the cloud stopped this client, e.g. `client_too_old`; it stays stopped until replaced. */
type Stop = string

/** A refusal no retry can fix; any other failure, a lapsed sign-in included, is retried after a backoff. */
function stopFor(failure: ConnectorFailure): Stop | null {
  return failure.status === 426 ? 'client_too_old' : null
}

export class ConnectorPollClient {
  readonly seam: ExternalConversationSeam
  private readonly host: ExternalConversationHost
  private readonly transport: ConnectorTransport
  private readonly stopped = new AbortController()
  private readonly acks: ConnectorSendQueue<ConnectorAck>
  private readonly sendAcks: ConnectorBatchSender<ConnectorAck>
  private readonly sendEvents: ConnectorBatchSender<ConnectorEvent>
  // Received in this process and not yet confirmed done.
  private readonly active = new Set<string>()
  private readonly random: () => number
  private releaseWatch: (() => void) | null = null
  // The last hello the cloud took; it scopes the poll and the numbered events.
  private helloRev = 0
  // What the cloud was last told; null makes the next cycle say hello.
  private helloSaid: string | null = null
  private failures = 0
  private stopReason: Stop | null = null

  constructor(private readonly options: ConnectorPollClientOptions) {
    this.seam = options.seam
    this.transport = options.transport
    this.random = options.random ?? Math.random
    this.host = options.machine.conversationHost()
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
    // Every hello restarts the numbering with a snapshot, so the current one always owns the queue.
    this.sendEvents = (events, seq) =>
      this.post(CONNECTOR_PATHS.events, { v: 1, helloRev: this.helloRev, seq, events })
  }

  start(): void {
    // A disable disposes the seam; nothing here may outlive it.
    this.seam.signal.addEventListener('abort', () => this.stop(), {
      once: true,
      signal: this.stopped.signal
    })
    // Turn ends that finish before the first hello still reach the outbox; only sending waits for it.
    this.watch()
    this.acks.attach(this.sendAcks)
    void this.run()
  }

  stop(): void {
    this.stopped.abort()
    // Confirmations still owed are listed as unsettled after the next hello and settled from receipts.
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
    if (this.stopReason) {
      console.warn(`[connector] Orca Cloud stopped this connection: ${this.stopReason}`)
    }
  }

  /** One hello-if-needed and one held poll; returns why to stop, or null to go on. */
  private async cycle(): Promise<Stop | null> {
    const { machine } = this.options
    const said = { agents: machine.agents(), projects: machine.projects() }
    // A hello restarts the numbered events with a snapshot, which also restates anything the caps dropped.
    if (JSON.stringify(said) !== this.helloSaid || this.options.events.needsSnapshot) {
      const refused = await this.hello(said)
      if (refused) {
        return stopFor(refused) ?? this.backoff(refused)
      }
    }
    const sentAt = performance.now()
    const polled = await this.transport.call(
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
      // The cloud wants hello again; forgetting what was said makes the next cycle say it.
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

  /** Null once the cloud took it; otherwise why not. Each hello also gets a fresh watch and snapshot. */
  private async hello(said: {
    agents: string[]
    projects: ConnectorProject[]
  }): Promise<ConnectorFailure | null> {
    const { machine } = this.options
    // Monotonic across restarts, so the cloud never keeps an older process's hello.
    const helloRev = Math.max(this.helloRev + 1, Date.now())
    const answer = await this.transport.call(
      CONNECTOR_PATHS.hello,
      {
        v: 1,
        helloRev,
        contract: CONNECTOR_CONTRACT_VERSION,
        orcaVersion: machine.orcaVersion,
        platform: process.platform,
        runtime: machine.runtime,
        hostName: machine.hostName,
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
    // A fresh watch's first event is the snapshot, which opens this hello's numbered events.
    this.watch()
    this.options.events.attach(this.sendEvents)
    return null
  }

  private watch(): void {
    const { events } = this.options
    const previous = this.releaseWatch
    this.releaseWatch = this.seam.watch(this.host, (event) => events.observe(event))
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
    // A receipt still running can fail; its outcome is then unknown, and it is still never run again.
    const result: ConnectorDeliveryResult = await this.seam.recorded(conversation, deliveryId).then(
      (recorded) => recorded ?? { outcome: 'unknown', reason: 'no_local_record' },
      (error: unknown) => ({
        outcome: 'unknown',
        reason: error instanceof Error && error.message ? error.message : 'failed'
      })
    )
    if (this.stopped.signal.aborted) {
      return
    }
    this.acks.push({ deliveryId, step: 'done', result })
  }

  private async obey(raw: unknown): Promise<Stop | null> {
    const control = ConnectorPollControl.safeParse(raw)
    if (!control.success) {
      return null
    }
    if ('stop' in control.data) {
      return control.data.stop
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
    const sent = await this.transport.call(path, body, z.unknown(), { signal: this.stopped.signal })
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
