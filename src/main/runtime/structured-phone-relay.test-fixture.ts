import './rpc/unused-default-rpc-methods.test-fixture'
import { expect, vi } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import type { AgentSessionAttentionEdge } from '../../shared/agent-session-attention'
import type { RpcResponse } from './rpc/core'
import type { RpcDispatchStreamingOptions } from './rpc/dispatcher-stream-options'
import { RuntimeSubscriptionRegistry } from './runtime-subscription-registry'
import { dispatcher } from './rpc/methods/structured-agent-session-rpc.test-fixture'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  hostTestState,
  attach,
  envelope,
  CALLER
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestMessage,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from './runtime-mobile-notification-controller'
import {
  createStructuredAttentionMobileDelivery,
  subscribeStructuredAgentSessionAttention
} from './structured-agent-session-mobile-attention'

// Literal2165558 Electron capabilities, including its native-client spread; stream params were {}.
export const HISTORICAL_NATIVE_CLIENT = {
  clientKind: 'runtime',
  pairedDeviceId: CALLER.callerKey,
  clientCapabilities: [
    'session-tabs.close-intent.v1',
    'agent-session.session-boundary.v1',
    'worktree.visibility-defaults.v1',
    'worktree.visibility-source-defaults.v1',
    'worktree.github-pr-suppression.v1',
    'automation.owner-fencing.v1',
    'automation.create-idempotency.v1',
    'agent.launch.v2',
    'agent-session.pending-send-result.v1',
    'agent-session.accepted-send.v1',
    'agent-session.structured.v1',
    'agent-session.structured.claude.v1',
    'agent-session.structured.client-launch-mode.v1',
    'browser.clientHost.v1',
    'browser.clientHost.pageMetadata.v1',
    'session-tabs.retirement-proof-delta.v1',
    'worktree.background-removal.v1'
  ]
} satisfies RpcDispatchStreamingOptions

export async function phoneRelayFlow() {
  const h = hostTestState()
  await attach()
  setStructuredAgentSessionHost(h.host)
  const registry = new RuntimeSubscriptionRegistry()
  const rpc = dispatcher({
    registerOwnedSubscriptionCleanup: registry.registerOwned.bind(registry),
    registerSubscriptionCleanup: registry.register.bind(registry),
    cleanupSubscription: registry.cleanup.bind(registry)
  })
  const b = new RuntimeMobileNotificationController()
  const a = new RuntimeMobileNotificationController()
  b.configureDismissalStore(h.root)
  const sent: MobileNotificationEvent[] = []
  const forwarded: MobileNotificationEvent[] = []
  b.onDispatched((event) => sent.push(event))
  a.onDispatched((event) => forwarded.push(event))
  const settings = {
    enabled: true,
    agentTaskComplete: true,
    terminalBell: true,
    suppressWhenFocused: false,
    customSoundId: 'system' as const,
    customSoundPath: null,
    customSoundVolume: 1,
    mutedNotificationSourceIds: [],
    notifyHiddenWorkspaces: true
  }
  const delivery = (controller: RuntimeMobileNotificationController) =>
    createStructuredAttentionMobileDelivery({
      readNotificationSettings: () => settings,
      readWorkspaceLabels: () => ({}),
      isWorkspaceMuted: () => false,
      dispatch: controller.dispatch.bind(controller),
      reconcile: controller.reconcileStructuredPromptAttention.bind(controller),
      onTurnStarted: controller.retireLiveStructuredTurn.bind(controller),
      now: Date.now
    })
  subscribeStructuredAgentSessionAttention(h.host, delivery(b))
  const relay = delivery(a)
  const journal = h.host.collaboratorsForTests().sessions.get(SESSION)!.journal
  const events = h.acquire.mock.calls.at(-1)![0].events
  if (!events) {
    throw new Error('Provider events missing')
  }
  let request = 0
  const controllers: AbortController[] = []
  const stream = async (
    params: unknown,
    options: RpcDispatchStreamingOptions = HISTORICAL_NATIVE_CLIENT,
    forward = false,
    onFrame?: (response: RpcResponse) => void
  ) => {
    const controller = new AbortController()
    controllers.push(controller)
    const replies: RpcResponse[] = []
    const id = `stream-${++request}`
    await rpc.dispatchStreaming(
      { id, authToken: '', method: 'agentSession.subscribeTurnCompletions', params },
      (raw) => {
        const response: RpcResponse = JSON.parse(raw)
        replies.push(response)
        onFrame?.(response)
        if (forward && response.ok) {
          const result = response.result
          if (result && typeof result === 'object' && 'type' in result && result.type !== 'end') {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the actual registered, typed completion method emits these frames.
            relay.deliver(result as AgentSessionAttentionEdge, undefined)
          }
        }
      },
      { ...options, connectionId: id, signal: controller.signal }
    )
    return { close: () => controller.abort(), replies, controller }
  }
  const send = async (
    text: string,
    client: RpcDispatchStreamingOptions = HISTORICAL_NATIVE_CLIENT
  ) => {
    const body = hostTestMessage(text)
    const command = envelope('agentSession.send', { body })
    const response = await rpc.dispatch(
      {
        id: `send-${++request}`,
        authToken: '',
        method: 'agentSession.send',
        params: { envelope: command, body }
      },
      client
    )
    expect(response.ok).toBe(true)
    await vi.waitFor(() =>
      expect(journal.submission(command.clientOperationId)?.dispatchState).toBe('accepted')
    )
    return command.clientOperationId
  }
  const turn = async (id: string, operation: string, state: 'running' | 'completed') => {
    const identity = { provider: 'codex' as const, threadId: THREAD, turnId: id, ordinal: 0 }
    events.appendItem(
      identity,
      {
        kind: 'turn',
        turnId: id,
        state,
        userItemId: agentJournalSubmissionKey(operation),
        ...(state === 'completed' ? { outcome: 'success' as const } : {})
      },
      { turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(identity) } }
    )
    await h.host.flushStreamedEvents(SESSION)
  }
  const prompt = async (id: number, turnId: string) => {
    const identity = { provider: 'codex' as const, threadId: THREAD, turnId, ordinal: id }
    events.appendItem(
      identity,
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
      { turnScope: { kind: 'turn', turnItemId: agentJournalItemKey({ ...identity, ordinal: 0 }) } }
    )
    await h.host.flushStreamedEvents(SESSION)
  }
  const attachOtherSource = async () => {
    const sessionId = 'second-session'
    const params = hostTestAttachParams(null)
    const originalAcquire = h.acquire.getMockImplementation()
    if (!originalAcquire) {
      throw new Error('Missing acquire fixture')
    }
    h.acquire.mockImplementationOnce(async (input) => {
      const acquired = await originalAcquire(input)
      if (!acquired.link) {
        throw new Error('Expected the attached provider handle')
      }
      return {
        ...acquired,
        process: { ...acquired.process, pid: 4343, spawnToken: input.spawnToken },
        link: { ...acquired.link, origin: 'created', handle: codexProviderHandle('thread-second') }
      }
    })
    expect(
      await h.host.attach(
        CALLER,
        hostTestAttachParams(null, {
          envelope: { ...params.envelope, sessionId },
          providerHandle: { kind: 'codex', threadId: 'thread-second' }
        })
      )
    ).toMatchObject({ ok: true })
    return sessionId
  }
  return {
    h,
    a,
    b,
    sent,
    forwarded,
    settings,
    registry,
    rpc,
    journal,
    stream,
    send,
    turn,
    prompt,
    attachOtherSource,
    async close() {
      controllers.forEach((controller) => controller.abort())
      setStructuredAgentSessionHost(null)
      await Promise.all([a.closeDismissals(), b.closeDismissals()])
    }
  }
}
