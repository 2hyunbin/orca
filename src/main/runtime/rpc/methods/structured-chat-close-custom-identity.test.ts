import { expect, it, vi } from 'vitest'
import { HOST_TEST_SESSION } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  WORKTREE,
  call,
  createChat,
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
async function graphTab(tabId: string, sessionId = HOST_TEST_SESSION) {
  const saved = await snapshot()
  const source = saved.tabs.find(
    (tab) => tab.type === 'agent-session' && tab.sessionId === sessionId
  )
  if (!source) {
    throw new Error('chat missing')
  }
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [{ ...saved, tabs: [{ ...source, id: tabId }] }]
  })
}
function close(tabId: string) {
  return call('session.tabs.close', { worktree: WORKTREE, tabId, reason: 'user' })
}
function holdCensus() {
  const reached = deferred()
  const release = deferred()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the existing census await is controlled to establish close ordering.
  const internal = runtime as unknown as {
    refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
  }
  vi.spyOn(internal, 'refreshMobileSessionPtyRecords')
    .mockImplementationOnce(async () => {
      reached.resolve()
      await release.promise
      return new Set()
    })
    .mockResolvedValue(new Set())
  return { reached, release }
}
it.each([false, true])(
  'an earlier custom-listed close cannot erase a later explicit reveal, graph-only=%s',
  async (graphOnly) => {
    await createChat(HOST_TEST_SESSION, graphOnly ? undefined : 'custom-chat-tab')
    await graphTab('custom-chat-tab')
    const { reached, release } = holdCensus()
    const closing = close('custom-chat-tab')
    await reached.promise
    const revealing = call('agentSession.reveal', { sessionId: HOST_TEST_SESSION })
    try {
      await Promise.race([revealing, new Promise<void>((resolve) => setTimeout(resolve, 100))])
    } finally {
      release.resolve()
    }
    expect(await closing).toMatchObject({ ok: true, result: { closed: true } })
    expect(await revealing).toMatchObject({ ok: true, result: { ok: true } })
    expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
    expect((await snapshot()).tabs.map((tab) => tab.id)).toEqual([
      `agent-session:${HOST_TEST_SESSION}`
    ])
  }
)
