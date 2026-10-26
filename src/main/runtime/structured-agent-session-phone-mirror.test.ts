import { expect, it, vi } from 'vitest'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { HISTORICAL_NATIVE_CLIENT, phoneRelayFlow } from './structured-phone-relay.test-fixture'
import { RuntimeMobileNotificationController } from './runtime-mobile-notification-controller'

it('uses actual receipt origin and a registered source stream, then retires only a genuine later live root', async () => {
  const f = await phoneRelayFlow()
  const callers: (string | null)[] = []
  const originalCaller = f.h.host.phoneAlertCaller
  vi.spyOn(f.h.host, 'phoneAlertCaller').mockImplementation((edge) => {
    const caller = originalCaller(edge)
    callers.push(caller)
    return caller
  })
  const relay = await f.stream(
    { includePrompts: true, phoneRelaySessionId: SESSION },
    undefined,
    true
  )
  const notifications = () => f.sent.filter((event) => event.type === 'notification')
  const dismissals = () => f.sent.filter((event) => event.type === 'dismiss')
  try {
    const first = await f.send('From the forwarding desktop')
    await f.turn('first', first, 'running')
    await f.turn('first', first, 'completed')
    expect(callers).toEqual([CALLER.callerKey])
    expect(notifications()).toEqual([])
    expect(f.forwarded.filter((event) => event.type === 'notification')).toHaveLength(1)
    relay.close()
    const second = await f.send('Desktop stream disconnected before the news')
    await f.turn('second', second, 'running')
    await f.turn('second', second, 'completed')
    expect(notifications()).toHaveLength(1)
    const alert = notifications()[0]!
    const third = await f.send('Acceptance is not a start')
    expect(dismissals()).toEqual([])
    await f.turn('third', third, 'running')
    expect(dismissals()).toEqual([
      expect.objectContaining({
        dismissedDelivery: {
          notificationId: alert.notificationId,
          notificationEpoch: alert.notificationEpoch,
          notificationSeq: alert.notificationSeq
        }
      })
    ])
    await f.turn('third', third, 'completed')
    await f.stream({ includePrompts: true, phoneRelaySessionId: SESSION }, undefined, true)
    await f.turn('unknown-origin', 'not-a-submission', 'running')
    await f.turn('unknown-origin', 'not-a-submission', 'completed')
    expect(callers.at(-1)).toBeNull()
    expect(notifications()).toHaveLength(3)
    const count = dismissals().length
    const restarted = new RuntimeMobileNotificationController()
    const restartedEvents: unknown[] = []
    const stopRestarted = restarted.onDispatched((event) => restartedEvents.push(event))
    try {
      restarted.retireLiveStructuredTurn(SESSION, f.journal.cursor(), 0)
      expect(restartedEvents).toEqual([])
      expect(dismissals()).toHaveLength(count)
    } finally {
      stopRestarted()
      await restarted.closeDismissals()
    }
  } finally {
    await f.close()
  }
})

it('admits the2165558 native request and {} subscription without treating browser support as prompt forwarding', async () => {
  const f = await phoneRelayFlow()
  try {
    const old = await f.stream({})
    const command = await f.send('Historical plain-text follow-up')
    await f.turn('historical-client', command, 'running')
    await f.prompt(1, 'historical-client')
    expect(f.h.host.hasPhoneRelay(SESSION, CALLER.callerKey)).toBe(false)
    expect(old.replies).toEqual([])
    expect(f.sent.filter((event) => event.type === 'notification')).toHaveLength(1)
    await f.turn('historical-client', command, 'completed')
    expect(old.replies.some((reply) => reply.ok)).toBe(true)
  } finally {
    await f.close()
  }
})

it('requires prompt opt-in, paired runtime identity and a readable existing source before insertion', async () => {
  const f = await phoneRelayFlow()
  try {
    const declaration = { includePrompts: true, phoneRelaySessionId: SESSION }
    for (const [params, client] of [
      [{ phoneRelaySessionId: SESSION }, HISTORICAL_NATIVE_CLIENT],
      [declaration, { ...HISTORICAL_NATIVE_CLIENT, clientKind: 'mobile' as const }],
      [
        declaration,
        {
          clientKind: 'runtime' as const,
          clientCapabilities: HISTORICAL_NATIVE_CLIENT.clientCapabilities
        }
      ],
      [{ ...declaration, phoneRelaySessionId: 'missing' }, HISTORICAL_NATIVE_CLIENT]
    ] as const) {
      const rejected = await f.stream(params, client)
      expect(rejected.replies).toEqual([expect.objectContaining({ ok: false })])
      expect(f.h.host.hasPhoneRelay(SESSION, CALLER.callerKey)).toBe(false)
    }
    const aborted = new AbortController()
    aborted.abort()
    const replies: string[] = []
    await f.rpc.dispatchStreaming(
      {
        id: 'already-aborted',
        authToken: '',
        method: 'agentSession.subscribeTurnCompletions',
        params: declaration
      },
      (raw) => replies.push(raw),
      { ...HISTORICAL_NATIVE_CLIENT, signal: aborted.signal }
    )
    expect(f.h.host.hasPhoneRelay(SESSION, CALLER.callerKey)).toBe(false)
    const accepted = await f.stream({ ...declaration, callerKey: 'spoofed', futureField: true })
    expect(accepted.replies).toEqual([])
    expect(f.h.host.hasPhoneRelay(SESSION, CALLER.callerKey)).toBe(true)
    expect(f.h.host.hasPhoneRelay(SESSION, 'spoofed')).toBe(false)
    accepted.close()
    expect(f.h.host.hasPhoneRelay(SESSION, CALLER.callerKey)).toBe(false)
  } finally {
    await f.close()
  }
})

it('leaves watcher, other caller and unknown work sending, and keeps deliberate source-off policy', async () => {
  const f = await phoneRelayFlow()
  try {
    await f.stream({ includePrompts: true })
    const source = await f.stream(
      { includePrompts: true, phoneRelaySessionId: SESSION },
      undefined,
      true
    )
    const cases = [
      { pairedDeviceId: 'another-desktop', clientKind: 'runtime' as const },
      { caller: { kind: 'desktop' as const }, clientKind: undefined },
      { caller: { kind: 'local-cli' as const }, clientKind: undefined },
      { pairedDeviceId: 'phone', clientKind: 'mobile' as const }
    ]
    for (const [index, options] of cases.entries()) {
      const op = await f.send(`Other origin${index}`, { ...HISTORICAL_NATIVE_CLIENT, ...options })
      await f.turn(`other-${index}`, op, 'running')
      await f.turn(`other-${index}`, op, 'completed')
    }
    expect(f.sent.filter((event) => event.type === 'notification')).toHaveLength(cases.length)
    f.settings.enabled = false
    const own = await f.send('Intentional disabled desktop policy')
    await f.turn('disabled', own, 'running')
    await f.turn('disabled', own, 'completed')
    expect(f.sent.filter((event) => event.type === 'notification')).toHaveLength(cases.length)
    expect(f.forwarded.at(-1)).toMatchObject({ type: 'notification', desktopAllowed: false })
    source.close()
    f.settings.enabled = true
    const fallback = await f.send('Still watching, no responsibility')
    await f.turn('watch-only', fallback, 'running')
    await f.turn('watch-only', fallback, 'completed')
    expect(f.sent.filter((event) => event.type === 'notification')).toHaveLength(cases.length + 1)
  } finally {
    await f.close()
  }
})

it('keeps source responsibility across a journal roll while stale and unreadable turn origins send', async () => {
  const f = await phoneRelayFlow()
  try {
    await f.stream({ includePrompts: true, phoneRelaySessionId: SESSION }, undefined, true)
    const oldOperation = await f.send('Before rollover')
    await f.turn('old-epoch', oldOperation, 'running')
    await f.turn('old-epoch', oldOperation, 'completed')
    const oldCursor = f.journal.cursor()
    await f.journal.rollEpoch(
      'unreconcilable_prefix',
      f.h.store.getRecord(SESSION)!.lease.runtimeFence
    )
    expect(f.h.host.hasPhoneRelay(SESSION, CALLER.callerKey)).toBe(true)
    const operation = await f.send('After rollover')
    await f.turn('new-epoch', operation, 'running')
    await f.turn('new-epoch', operation, 'completed')
    expect(f.sent.filter((event) => event.type === 'notification')).toHaveLength(0)
    expect(f.forwarded.filter((event) => event.type === 'notification')).toHaveLength(2)
    const edge = {
      type: 'completion' as const,
      completion: {
        scope: f.h.store.getRecord(SESSION)!.location,
        sessionId: SESSION,
        turnId: 'new-epoch',
        outcome: 'success' as const,
        completedAt: 1,
        journalCursor: oldCursor
      }
    }
    expect(f.h.host.phoneAlertCaller(edge)).toBeNull()
    const unreadable = vi
      .spyOn(f.h.store, 'readCommandReceiptCandidates')
      .mockImplementation(() => {
        throw new Error('Receipt storage unreadable')
      })
    const next = await f.send('Unreadable origin')
    await f.turn('unreadable', next, 'running')
    await f.turn('unreadable', next, 'completed')
    expect(f.sent.filter((event) => event.type === 'notification')).toHaveLength(1)
    unreadable.mockRestore()
  } finally {
    await f.close()
  }
})
