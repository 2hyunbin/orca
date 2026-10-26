import './rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER
} from '../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { openRigTurnFor } from '../native-chat/agent-session-wire/structured-agent-session-queued-rig-turn.test-fixture'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { RuntimeSubscriptionRegistry } from './runtime-subscription-registry'
import { dispatcher } from './rpc/methods/structured-agent-session-rpc.test-fixture'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { AgentSessionTurnCompletionEvent } from '../../shared/agent-session-wire'
import { HISTORICAL_NATIVE_CLIENT } from './structured-phone-relay.test-fixture'
import { subscribeStructuredAgentSessionAttention } from './structured-agent-session-mobile-attention'

it('retains the original queued caller on automatic handoff through the actual scoped RPC feed', async () => {
  const rig = await createQueuedMessageTestRig()
  setStructuredAgentSessionHost(rig.host)
  const registry = new RuntimeSubscriptionRegistry()
  const rpc = dispatcher({
    registerOwnedSubscriptionCleanup: registry.registerOwned.bind(registry),
    registerSubscriptionCleanup: registry.register.bind(registry),
    cleanupSubscription: registry.cleanup.bind(registry)
  })
  const delivery = { deliver: vi.fn(), reconcile: vi.fn() }
  subscribeStructuredAgentSessionAttention(rig.host, delivery)
  const abort = new AbortController()
  const frames: AgentSessionTurnCompletionEvent[] = []
  try {
    await rpc.dispatchStreaming(
      {
        id: 'queued-relay',
        authToken: '',
        method: 'agentSession.subscribeTurnCompletions',
        params: { includePrompts: true, phoneRelaySessionId: SESSION }
      },
      (raw) => {
        const response: RuntimeRpcResponse<AgentSessionTurnCompletionEvent> = JSON.parse(raw)
        expect(response.ok).toBe(true)
        if (response.ok) {
          frames.push(response.result)
        }
      },
      { ...HISTORICAL_NATIVE_CLIENT, signal: abort.signal, connectionId: 'queued-relay' }
    )
    const working = await rig.workingSend()
    const queued = rig.send('Original queued request', 'queue-if-active')
    expect(await queued.result).toMatchObject({ ok: true })
    await rig.settleAccepted(working, 'first')
    await eventually(async () => expect(await rig.handoff(queued.id)).toBeDefined())
    const operation = await rig.handoffId(queued.id)
    await openRigTurnFor(rig, operation)
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: `turn-of-${operation}`, ordinal: 1 },
      {
        kind: 'approval',
        title: 'Allow?',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: {
          state: 'pending',
          selectedOptionId: null,
          resolvedBy: null,
          resolvedAt: null
        }
      },
      {
        fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
        turnScope: {
          kind: 'turn',
          turnItemId: agentJournalItemKey({
            provider: 'codex',
            threadId: THREAD,
            turnId: `turn-of-${operation}`,
            ordinal: 0
          })
        }
      }
    )
    await rig.host.flushStreamedEvents(SESSION)
    const prompt = frames.find((event) => event.type === 'prompt')
    expect(prompt).toBeDefined()
    if (prompt?.type !== 'prompt') {
      throw new Error('Expected the real handoff prompt')
    }
    expect(rig.host.phoneAlertCaller(prompt)).toBe(QUEUED_RIG_CALLER.callerKey)
    expect(rig.host.hasPhoneRelay(SESSION, QUEUED_RIG_CALLER.callerKey)).toBe(true)
    expect(delivery.deliver).not.toHaveBeenCalled()
  } finally {
    abort.abort()
    setStructuredAgentSessionHost(null)
    await rig.dispose()
  }
})
