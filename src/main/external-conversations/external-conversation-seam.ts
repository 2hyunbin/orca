import type { AgentStatusHooksSettings } from '../../shared/agent-status-hooks-setting'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { admitConnectorAgent } from './connector-agents'
import { ConversationChain } from './external-conversation-chain'
import { DeliveryReceipts } from './external-conversation-delivery-receipts'
import {
  ExternalConversationIndex,
  writeLink,
  type ExternalConversationLinkStore,
  type LinkedConversation
} from './external-conversation-links'
import {
  bindPane,
  deliverFollowUp,
  waitWhileAgentAsks,
  type FollowUpTerminal,
  type PaneInputState
} from './external-conversation-send'
import {
  launchConversation,
  runtimeConversationLauncher,
  type ConversationLaunchInput,
  type ConversationLauncher
} from './external-conversation-start'
import {
  conversationId,
  refused,
  type ConversationKey,
  type ConversationStart,
  type Delivery
} from './external-conversation-types'

/** What the seam drives on its host: the launch path and the linked terminals. */
export type ExternalConversationHost = {
  launcher: ConversationLauncher
  terminal: FollowUpTerminal
}

export function runtimeConversationHost(runtime: OrcaRuntimeService): ExternalConversationHost {
  return { launcher: runtimeConversationLauncher(runtime), terminal: runtime }
}

export type ExternalConversationSeamDeps = {
  store: ExternalConversationLinkStore
  readSettings: () => AgentStatusHooksSettings
  /** Workspace removals and renames; returns the release. */
  subscribeInvalidations: (invalidate: () => void) => () => void
}

type StartInput = Omit<ConversationLaunchInput, 'agent'> & { agent: string }

/**
 * The connector seam for one enabled period. Turning connectors off disposes it, which settles
 * held and queued work `connectors_disabled` and drops its index, receipts and subscriptions;
 * turning them on builds a fresh one.
 */
export class ExternalConversationSeam {
  private readonly abort = new AbortController()
  private readonly index: ExternalConversationIndex
  private readonly receipts = new DeliveryReceipts()
  private readonly chain = new ConversationChain()
  private readonly paneInput: PaneInputState = { claims: new Set(), stale: new Map() }
  /** Conversations this period started, so a second start for one shares its creation. */
  private readonly startedHere = new Set<string>()
  private readonly releaseInvalidations: () => void

  constructor(private readonly deps: ExternalConversationSeamDeps) {
    this.index = new ExternalConversationIndex(deps.store)
    this.releaseInvalidations = deps.subscribeInvalidations(() => this.index.invalidate())
  }

  /** Deferred work rechecks this before each write, so nothing writes after a disable. */
  get signal(): AbortSignal {
    return this.abort.signal
  }

  dispose(reason: 'connectors_disabled'): void {
    this.releaseInvalidations()
    this.abort.abort(reason)
  }

  start(
    host: ExternalConversationHost,
    key: ConversationKey,
    deliveryId: string,
    input: StartInput
  ): Promise<ConversationStart> {
    const id = conversationId(key)
    const delivery = this.receipts.run(
      receiptId(key, deliveryId),
      JSON.stringify(['start', input.agent, input.target, input.prompt]),
      () =>
        this.chain.enqueue(id, async () => {
          const { agent } = input
          if (this.signal.aborted) {
            return refused('connectors_disabled')
          }
          if (!admitConnectorAgent(this.deps.readSettings(), agent)) {
            return refused('unsupported_agent')
          }
          const linked = this.index.lookup(key)
          if (linked) {
            // A link from before this period cannot say what became of its launch.
            return this.startedHere.has(id)
              ? this.deliver(host.terminal, key, linked, deliveryId, input.prompt)
              : { outcome: 'unknown', reason: 'launch_outcome_unknown' }
          }
          try {
            return await launchConversation(
              host.launcher,
              { ...input, agent },
              (workspace, paneKey) => {
                writeLink(this.deps.store, workspace, {
                  ...key,
                  paneKey,
                  agent,
                  createdAt: Date.now()
                })
                this.index.invalidate()
                this.startedHere.add(id)
              }
            )
          } finally {
            this.index.invalidate()
          }
        })
    )
    return (delivery ?? Promise.resolve(refused('delivery_id_reused'))).then((initial) => ({
      conversation: key,
      initial
    }))
  }

  send(
    host: ExternalConversationHost,
    key: ConversationKey,
    deliveryId: string,
    text: string
  ): Promise<Delivery> {
    const id = conversationId(key)
    const delivery = this.receipts.run(
      receiptId(key, deliveryId),
      JSON.stringify(['send', text]),
      () =>
        this.chain.enqueue(id, async () => {
          if (this.signal.aborted) {
            return refused('connectors_disabled')
          }
          const linked = this.index.lookup(key)
          if (!linked) {
            throw new Error('external_conversation_not_found')
          }
          return this.deliver(host.terminal, key, linked, deliveryId, text)
        })
    )
    return delivery ?? Promise.resolve(refused('delivery_id_reused'))
  }

  private async deliver(
    terminal: FollowUpTerminal,
    key: ConversationKey,
    { link }: LinkedConversation,
    deliveryId: string,
    text: string
  ): Promise<Delivery> {
    const pane = bindPane(terminal, link.paneKey)
    if (!pane) {
      return refused('agent_not_reachable')
    }
    const held = await waitWhileAgentAsks(terminal, pane, this.signal)
    if (held !== 'ready') {
      this.chain.settleWaiting(conversationId(key), held)
      return refused(held)
    }
    return deliverFollowUp(terminal, this.paneInput, {
      pane,
      agent: link.agent,
      text,
      requestId: receiptId(key, deliveryId),
      signal: this.signal
    })
  }
}

function receiptId(key: ConversationKey, deliveryId: string): string {
  return JSON.stringify([key.source, key.externalId, deliveryId])
}
