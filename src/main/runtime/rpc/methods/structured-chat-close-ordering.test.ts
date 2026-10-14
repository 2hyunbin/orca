import { expect, it, vi } from 'vitest'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestOperationId
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  createStructuredAgentSessionForWorktree,
  structuredAgentSessionCreateIntentFingerprint
} from './structured-agent-session-create'
import {
  WORKTREE,
  acquisitions,
  call,
  caller,
  createChat,
  host,
  runtime,
  snapshot,
  store
} from './structured-chat-tab-table.test-fixture'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createParams() {
  const params = {
    worktree: WORKTREE,
    agent: 'codex' as const,
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    }
  }
  params.envelope.payloadFingerprint = structuredAgentSessionCreateIntentFingerprint(params)
  return params
}

async function closeChat() {
  return call('session.tabs.close', {
    worktree: WORKTREE,
    tabId: `agent-session:${HOST_TEST_SESSION}`,
    reason: 'user'
  })
}

it.each(['acquired', 'at-rest', 'in-process'] as const)(
  'cancels an earlier %s create still preparing, without poisoning the next create',
  async (mode) => {
    const reached = deferred()
    const release = deferred()
    const intent = hostTestAttachParams(null)
    vi.spyOn(runtime, 'resolveStructuredAgentSessionCreateIntent').mockImplementation(async () => {
      reached.resolve()
      await release.promise
      return intent
    })
    const params = createParams()
    const creating =
      mode === 'in-process'
        ? createStructuredAgentSessionForWorktree({
            ...params,
            runtime,
            ensureHost: async () => host,
            caller,
            activate: true
          }).then((result) => result.ok)
        : call('agentSession.create', params, {
            clientKind: 'runtime',
            clientCapabilities: [
              STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
              ...(mode === 'at-rest' ? [AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY] : [])
            ]
          }).then((result) => result.result?.ok)
    await reached.promise
    try {
      expect(await closeChat()).toMatchObject({ ok: true, result: { closed: true } })
      expect(acquisitions).toBe(0)
    } finally {
      release.resolve()
    }
    expect(await creating).toBe(false)
    expect(acquisitions).toBe(0)
    expect(store.getRecord(HOST_TEST_SESSION)).toBeNull()
    expect(store.listVisibleSessionIds()).toEqual([])

    expect(await call('agentSession.create', createParams())).toMatchObject({
      ok: true,
      result: { ok: true }
    })
    expect(acquisitions).toBe(1)
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
      `agent-session:${HOST_TEST_SESSION}`
    ])
  }
)

it('does not publish an earlier reveal after a later close has finished', async () => {
  await createChat(HOST_TEST_SESSION)
  const reached = deferred()
  const release = deferred()
  const reveal = host.revealSession.bind(host)
  vi.spyOn(host, 'revealSession').mockImplementation(async (sessionId) => {
    const result = await reveal(sessionId)
    reached.resolve()
    await release.promise
    return result
  })
  const revealing = call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })
  await reached.promise
  try {
    expect(await closeChat()).toMatchObject({ ok: true, result: { closed: true } })
  } finally {
    release.resolve()
  }
  expect(await revealing).toMatchObject({
    ok: false,
    error: { code: 'agent_session_close_pending' }
  })
  expect(store.listVisibleSessionIds()).toEqual([])
  expect((await snapshot()).tabs).toEqual([])
  expect(await call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })).toMatchObject({
    ok: true,
    result: { ok: true }
  })
})
