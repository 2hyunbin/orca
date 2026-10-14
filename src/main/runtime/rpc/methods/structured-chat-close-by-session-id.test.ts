import { afterEach, expect, it, vi } from 'vitest'
import {
  RUNTIME_CAPABILITIES,
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { SESSION_TABS_CLOSE_AGENT_SESSION_BY_ID_RUNTIME_CAPABILITY } from '../../../../shared/session-tabs-close-capabilities'
import { SESSION_TAB_CLOSE_CANCELED_ERROR } from '../../../../shared/session-tab-close'
import { HOST_TEST_SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { STRUCTURED_AGENT_SESSION_REVEAL_CLOSE_WAIT_MS } from './structured-agent-session-reveal'
import {
  WORKTREE,
  call,
  closeSession,
  send,
  createChat,
  host,
  runtime,
  snapshot,
  store
} from './structured-chat-tab-table.test-fixture'

const CHAT_TAB = `agent-session:${HOST_TEST_SESSION}`
// The window and a paired desktop both close as a runtime client that reads chats.
const WINDOW = {
  clientKind: 'runtime' as const,
  clientCapabilities: [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
    SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY
  ]
}

function closeTab(worktree = WORKTREE, tabId = CHAT_TAB, client: typeof WINDOW = WINDOW) {
  return call('session.tabs.close', { worktree, tabId, reason: 'user' }, client)
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function relayWindowClose(relay: () => Promise<void> = async () => {}) {
  const closeSessionTab = vi.fn(relay)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chat close path uses only this relay.
  runtime.setNotifier({ closeSessionTab } as never)
  return closeSessionTab
}

async function settleTicks(count = 20): Promise<void> {
  for (let tick = 0; tick < count; tick++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function listedChatIds(): Promise<string[]> {
  return (await snapshot()).tabs.flatMap((tab) => (tab.type === 'agent-session' ? [tab.id] : []))
}

afterEach(() => {
  vi.useRealTimers()
})

it('stops the chat and drops its tab when the restore index cannot be written', async () => {
  await createChat(HOST_TEST_SESSION)
  expect(await send(HOST_TEST_SESSION, 'keep working')).toMatchObject({ ok: true })
  vi.spyOn(store, 'setSessionTabVisibility').mockRejectedValue(new Error('disk I/O error'))
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const close = vi.spyOn(host, 'close')

  expect(await closeTab()).toMatchObject({ ok: true, result: { closed: true } })

  expect(close).toHaveBeenCalledWith(HOST_TEST_SESSION, 'user-close')
  expect(closeSession).toHaveBeenCalledOnce()
  expect(await listedChatIds()).toEqual([])
})

it('closes it by session id: hidden in the restore index and stopped, with no window relay', async () => {
  await createChat(HOST_TEST_SESSION)
  // As before restore publishes it: the record exists, the list does not carry the tab.
  runtime.retireStructuredAgentSessionTabFromSnapshot(HOST_TEST_SESSION)
  setStructuredAgentSessionHost(null)
  Object.assign(runtime, { hasPersistedStructuredAgentSessionStore: () => true })
  const install = vi
    .spyOn(runtime, 'ensureStructuredAgentSessionHost')
    .mockImplementation(async () => {
      setStructuredAgentSessionHost(host)
    })
  const relay = relayWindowClose()
  const close = vi.spyOn(host, 'close')

  expect(await closeTab()).toMatchObject({ ok: true, result: { closed: true } })

  expect(close).toHaveBeenCalledWith(HOST_TEST_SESSION, 'user-close')
  expect(store.listVisibleSessionIds()).toEqual([])
  expect(relay).not.toHaveBeenCalled()
  expect(install).toHaveBeenCalledOnce()
})

it('answers a worktree mismatch, not tab_not_found, for a chat of another worktree', async () => {
  await createChat(HOST_TEST_SESSION)
  runtime.retireStructuredAgentSessionTabFromSnapshot(HOST_TEST_SESSION)
  const close = vi.spyOn(host, 'close')

  expect(await closeTab('id:another-worktree')).toMatchObject({
    ok: false,
    error: {
      code: 'agent_session_worktree_mismatch',
      message: 'agent_session_worktree_mismatch'
    }
  })

  expect(close).not.toHaveBeenCalled()
  expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
})

it.each([
  ['a client without chats', [SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY], 'codex'],
  ['a client that cannot render the agent', WINDOW.clientCapabilities, 'claude']
] as const)('answers tab_not_found to %s, stopping nothing', async (_client, caps, agent) => {
  await createChat(HOST_TEST_SESSION)
  runtime.retireStructuredAgentSessionTabFromSnapshot(HOST_TEST_SESSION)
  vi.spyOn(host, 'sessionAgent').mockReturnValue(agent)
  const close = vi.spyOn(host, 'close')

  expect(
    await closeTab(WORKTREE, CHAT_TAB, { clientKind: 'runtime', clientCapabilities: [...caps] })
  ).toMatchObject({ ok: false, error: { message: 'tab_not_found' } })

  expect(close).not.toHaveBeenCalled()
  expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
})

it('neither hides nor stops it when the window keeps the tab open', async () => {
  await createChat(HOST_TEST_SESSION)
  // As a pinned tab's declined confirm answers.
  relayWindowClose(async () => {
    throw new Error(SESSION_TAB_CLOSE_CANCELED_ERROR)
  })
  const close = vi.spyOn(host, 'close')

  expect(await closeTab()).toMatchObject({
    ok: false,
    error: { message: SESSION_TAB_CLOSE_CANCELED_ERROR }
  })

  expect(close).not.toHaveBeenCalled()
  expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
  expect(await listedChatIds()).toEqual([CHAT_TAB])
})

it('stays idempotent: both answer, the chat is stopped, hidden and unlisted', async () => {
  await createChat(HOST_TEST_SESSION)
  const close = vi.spyOn(host, 'close')

  const [byId, byTab] = await Promise.all([
    call('agentSession.close', { sessionId: HOST_TEST_SESSION }, WINDOW),
    closeTab()
  ])

  expect(byId).toMatchObject({ ok: true })
  expect(byTab).toMatchObject({ ok: true, result: { closed: true } })
  expect(close).toHaveBeenCalledWith(HOST_TEST_SESSION, 'user-close')
  expect(store.listVisibleSessionIds()).toEqual([])
  expect(await listedChatIds()).toEqual([])
})

it('waits for the close, then shows the chat', async () => {
  await createChat(HOST_TEST_SESSION)
  const windowAnswers = deferred()
  relayWindowClose(() => windowAnswers.promise)

  // Same tick: the close is marked in flight on arrival, before any of its awaits.
  const closed = closeTab()
  let revealAnswered = false
  const revealed = call('agentSession.reveal', { sessionId: HOST_TEST_SESSION }).then(
    (response) => {
      revealAnswered = true
      return response
    }
  )
  await settleTicks()
  expect(revealAnswered).toBe(false)
  windowAnswers.resolve()

  expect(await closed).toMatchObject({ ok: true, result: { closed: true } })
  expect(await revealed).toMatchObject({ ok: true, result: { ok: true } })
  expect(await listedChatIds()).toEqual([CHAT_TAB])
  expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
})

it('returns retry within three seconds when the provider close never settles', async () => {
  expect(STRUCTURED_AGENT_SESSION_REVEAL_CLOSE_WAIT_MS).toBe(3_000)
  await createChat(HOST_TEST_SESSION)
  const stopping = deferred()
  const release = deferred()
  closeSession.mockImplementationOnce(async () => {
    stopping.resolve()
    await release.promise
    return true
  })
  const closed = closeTab()
  await stopping.promise
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const revealed = call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })
    await vi.advanceTimersByTimeAsync(STRUCTURED_AGENT_SESSION_REVEAL_CLOSE_WAIT_MS)
    expect(await revealed).toMatchObject({
      ok: false,
      error: { code: 'agent_session_close_pending' }
    })
    expect(store.listVisibleSessionIds()).toEqual([])
  } finally {
    vi.useRealTimers()
    release.resolve()
    await closed
  }
})

it('advertises closing a chat by session id', () => {
  expect(RUNTIME_CAPABILITIES).toContain(SESSION_TABS_CLOSE_AGENT_SESSION_BY_ID_RUNTIME_CAPABILITY)
  expect(SESSION_TABS_CLOSE_AGENT_SESSION_BY_ID_RUNTIME_CAPABILITY).toBe(
    'session-tabs.close-agent-session-by-id.v1'
  )
})
