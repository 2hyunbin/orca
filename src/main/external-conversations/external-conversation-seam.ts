import type { AgentStatusHooksSettings } from '../../shared/agent-status-hooks-setting'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { admitConnectorAgent } from './connector-agents'
import { ConversationChain } from './external-conversation-chain'
import { DeliveryReceipts, type DeliveryReceiptDb } from './external-conversation-delivery-receipts'
import {
  findLink,
  writeLink,
  type ExternalConversationLinkStore,
  type LinkedConversation
} from './external-conversation-links'
import { deliverFollowUp, type FollowUpTerminal } from './external-conversation-send'
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
  receiptDb: () => DeliveryReceiptDb
  /** Worktree removals; returns the release. */
  onWorkspaceRemoved: (listener: (worktreeId: string) => void) => () => void
}

type StartInput = Omit<ConversationLaunchInput, 'agent'> & { agent: string }

/**
 * The connector seam for one enabled period. Turning connectors off disposes it: queued work
 * settles `connectors_disabled` at once and running work stops at its next boundary. Turning them
 * on builds a fresh one.
 */
export class ExternalConversationSeam {
  private readonly abort = new AbortController()
  private readonly chain = new ConversationChain(this.abort.signal)
  private readonly receipts: DeliveryReceipts
  /** Conversations this period started, so a second start for one shares its creation. */
  private readonly startedHere = new Set<string>()
  /** The workspace each conversation with work sent here is linked to. */
  private readonly linkedWorkspaces = new Map<string, string>()
  private readonly releaseRemovals: () => void

  constructor(private readonly deps: ExternalConversationSeamDeps) {
    this.receipts = new DeliveryReceipts(deps.receiptDb)
    // A removed workspace may keep its PTY registered a while; its held and queued sends end now.
    this.releaseRemovals = deps.onWorkspaceRemoved((worktreeId) => {
      for (const [id, linked] of this.linkedWorkspaces) {
        if (linked === worktreeId) {
          this.linkedWorkspaces.delete(id)
          this.chain.cancel(id, 'agent_not_reachable')
        }
      }
    })
  }

  /** Deferred work passes this to every effect, so nothing starts or writes after a disable. */
  get signal(): AbortSignal {
    return this.abort.signal
  }

  dispose(reason: 'connectors_disabled'): void {
    this.releaseRemovals()
    this.abort.abort(reason)
  }

  async start(
    host: ExternalConversationHost,
    key: ConversationKey,
    deliveryId: string,
    input: StartInput
  ): Promise<ConversationStart> {
    const initial = await this.receipts.run(
      key,
      deliveryId,
      'connector.start',
      [input.agent, input.target, input.prompt],
      () =>
        this.chain.enqueue(conversationId(key), async (signal) => {
          const { agent } = input
          if (!admitConnectorAgent(this.deps.readSettings(), agent)) {
            return refused('unsupported_agent')
          }
          const linked = findLink(this.deps.store, key)
          if (linked) {
            // A link from before this period cannot say what became of its launch.
            return this.startedHere.has(conversationId(key))
              ? this.deliver(host.terminal, key, linked, deliveryId, input.prompt, signal)
              : { outcome: 'unknown', reason: 'launch_outcome_unknown' }
          }
          return launchConversation(
            host.launcher,
            { ...input, agent },
            signal,
            (workspace, paneKey) => {
              writeLink(this.deps.store, workspace, {
                ...key,
                paneKey,
                agent,
                createdAt: Date.now()
              })
              this.startedHere.add(conversationId(key))
            }
          )
        })
    )
    return { conversation: key, initial }
  }

  send(
    host: ExternalConversationHost,
    key: ConversationKey,
    deliveryId: string,
    text: string
  ): Promise<Delivery> {
    const id = conversationId(key)
    return this.receipts.run(key, deliveryId, 'connector.send', [text], () => {
      const queued = findLink(this.deps.store, key)
      if (queued) {
        this.linkedWorkspaces.set(id, queued.workspace.worktreeId)
      }
      return this.chain.enqueue(id, async (signal) => {
        const linked = findLink(this.deps.store, key)
        if (!linked) {
          throw new Error('external_conversation_not_found')
        }
        return this.deliver(host.terminal, key, linked, deliveryId, text, signal)
      })
    })
  }

  private deliver(
    terminal: FollowUpTerminal,
    key: ConversationKey,
    { workspace, link }: LinkedConversation,
    deliveryId: string,
    text: string,
    signal: AbortSignal
  ): Promise<Delivery> {
    this.linkedWorkspaces.set(conversationId(key), workspace.worktreeId)
    return deliverFollowUp(terminal, {
      paneKey: link.paneKey,
      agent: link.agent,
      text,
      requestId: JSON.stringify([key.source, key.externalId, deliveryId]),
      signal
    })
  }
}
