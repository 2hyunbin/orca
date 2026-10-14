import type {
  AgentSessionQueuedMessageEditHoldParams,
  AgentSessionQueuedMessageEditHoldResult
} from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { callAgentSession } from './mobile-structured-agent-session-rpc'
import { structuredSessionOperationId } from './structured-session-operation-id'

export type MobileQueuedEditLease = {
  acquired: Promise<AgentSessionQueuedMessageEditHoldResult>
  end: () => void
}

/** The host expires abandoned holds; this pane renews only while its editor stays open. */
export function startMobileQueuedEditLease(args: {
  client: RpcClient
  sessionId: string
  messageId: string
  expectedBodyFingerprint: string
}): MobileQueuedEditLease {
  const editId = structuredSessionOperationId()
  let ended = false
  let held = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const call = (action: AgentSessionQueuedMessageEditHoldParams['action']) =>
    callAgentSession<AgentSessionQueuedMessageEditHoldResult>(
      args.client,
      'agentSession.queuedMessageEditHold',
      {
        sessionId: args.sessionId,
        messageId: args.messageId,
        editId,
        action,
        ...(action === 'acquire' ? { expectedBodyFingerprint: args.expectedBodyFingerprint } : {})
      },
      undefined,
      { failWhenDisconnected: true }
    )
  const acquired = call('acquire')
  // Release follows any pending acquire or renewal, so it cannot leave a late hold behind.
  let chain: Promise<unknown> = acquired.catch(() => undefined)
  const send = (action: 'acquire' | 'renew'): void => {
    chain = chain
      .then(() => (ended ? undefined : call(action)))
      .then(keepAlive, (error: unknown) => {
        console.warn('[queued-message-edit] edit hold request failed', error)
        keepAlive(undefined)
      })
  }
  const keepAlive = (answer: AgentSessionQueuedMessageEditHoldResult | undefined): void => {
    if (ended) {
      return
    }
    if (answer?.status === 'expired') {
      held = false
      send('acquire')
    } else if (answer === undefined || answer.status === 'held') {
      held ||= answer?.status === 'held'
      timer = setTimeout(() => send(held ? 'renew' : 'acquire'), 30_000)
    }
  }
  void acquired.then(keepAlive, (error: unknown) => {
    console.warn('[queued-message-edit] edit hold request failed', error)
    keepAlive(undefined)
  })
  return {
    acquired,
    end: () => {
      if (ended) {
        return
      }
      ended = true
      clearTimeout(timer)
      chain = chain
        .then(() => call('release'))
        .catch((error: unknown) => {
          console.warn('[queued-message-edit] edit hold release failed', error)
        })
    }
  }
}
