import type { AgentStatusHooksSettings } from '../../shared/agent-status-hooks-setting'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { admitConnectorAgent } from './connector-agents'
import { ConversationChain } from './external-conversation-chain'
import { DeliveryReceipts } from './external-conversation-delivery-receipts'
import {
  ExternalConversationIndex,
  writeLink,
  type ExternalConversationLinkStore
} from './external-conversation-links'
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
  type ConversationStart
} from './external-conversation-types'

/** What the seam drives on its host. */
export type ExternalConversationHost = { launcher: ConversationLauncher }

export function runtimeConversationHost(runtime: OrcaRuntimeService): ExternalConversationHost {
  return { launcher: runtimeConversationLauncher(runtime) }
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
          if (this.index.lookup(key)) {
            // Concurrent starts share the creation; only the first carried its prompt.
            return { outcome: 'unknown', reason: 'launch_outcome_unknown' }
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
}

function receiptId(key: ConversationKey, deliveryId: string): string {
  return JSON.stringify([key.source, key.externalId, deliveryId])
}
