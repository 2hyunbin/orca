import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { sendTerminalStreamInput } from './methods/terminal/terminal-input-delivery'
vi.mock('../../native-chat/agent-session-journal/journal-legacy-rest-worker', async () => {
  const { InProcessLegacyRestWorker } =
    await import('../../native-chat/agent-session-journal/journal-legacy-rest-replay-test-support')
  return { JournalLegacyRestWorker: InProcessLegacyRestWorker }
})

import './unused-default-rpc-methods.test-fixture'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { openAgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store-factory'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import { JournalLegacyRestInitializer } from '../../native-chat/agent-session-journal/journal-legacy-rest-initializer'
import { readJournalRestFacts } from '../../native-chat/agent-session-journal/journal-row-table'
import {
  setStructuredJournalReadiness,
  structuredJournalBackgroundReady
} from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from '../orca-runtime'
import { makeTuiIdlePty } from '../tui-idle-wait-test-harness'
import { RuntimeTerminalWait } from '../terminal/wait/terminal-wait'
import { RuntimeTerminalWaiterRegistry } from '../terminal/wait/terminal-waiter-registry'
import { RuntimeTerminalIdlePolls } from '../terminal/wait/terminal-idle-polls'
import { RpcDispatcher } from './dispatcher'
import { defineMethod, defineStreamingMethod, type RpcRequest } from './core'
import { TERMINAL_LIFECYCLE_METHODS } from './methods/terminal/terminal-lifecycle-methods'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-r3-rpc-background-'))
  setStructuredJournalReadiness(() => true)
})
afterEach(async () => {
  setStructuredJournalReadiness(() => false)
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it.each(['dispatch', 'streaming'] as const)(
  'derives real SQLite legacy work during an unbounded original terminal.wait over %s',
  async (transport) => {
    const database = openTestJournalHostDatabase(root)
    const sessionId = 'rpc-legacy-session'
    const journal = await openAgentSessionJournal({
      identity: {
        sessionId,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'claude',
        providerHandle: claudeProviderHandle('provider-1', null)
      },
      database,
      now: () => 100
    })
    await journal.appendItem(
      { provider: 'claude', sessionId: 'provider-1', uuid: 'turn' },
      { kind: 'turn', turnId: 'turn', state: 'running', startedAt: 100 },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE, fence: 7 }
    )
    await journal.close()
    database.db
      .prepare(
        'UPDATE journal_sessions SET open_turn_id=NULL,open_turn_since=NULL WHERE session_id=?'
      )
      .run(sessionId)
    const initialized = vi.fn()
    const failed = vi.fn()
    const initializer = new JournalLegacyRestInitializer({
      database,
      candidates: () => [sessionId],
      owner: () => 'ended',
      initialized,
      failed
    })
    const runtime = new OrcaRuntimeService()
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      rendererGeneration: 'r3-background',
      startupRestorationReady: true
    })
    const waiters = new RuntimeTerminalWaiterRegistry()
    const pty = makeTuiIdlePty()
    const evidence = {
      quiescenceMs: 500,
      getTabTitle: () => null,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => null,
      getFirstPartyAgentStatus: () => null,
      readScreenLines: () => null
    }
    const polls = new RuntimeTerminalIdlePolls({
      ...evidence,
      intervalMs: 100,
      getForegroundProcess: () => null,
      hasCommandPainted: () => false,
      readVisibleScreen: () => null,
      getLiveLeaf: (leaf) => leaf,
      resolve: (waiter, result) => waiters.resolve(waiter, result)
    })
    const terminalWait = new RuntimeTerminalWait(
      {
        ...evidence,
        defaultTimeoutMs: 300_000,
        getLivePty: () => ({ pty }),
        exitUnsettled: () => true,
        getLiveLeaf: () => {
          throw new Error('PTY fixture must own this wait')
        },
        getPaneAgent: () => null,
        startVisibleReadProbe: vi.fn()
      },
      waiters,
      polls
    )
    const entered = Promise.withResolvers<void>()
    vi.spyOn(runtime, 'waitForTerminal').mockImplementation((handle, options) => {
      const result = terminalWait.wait(handle, options)
      entered.resolve()
      return result
    })
    const shortEntered = Promise.withResolvers<void>()
    const shortFinish = Promise.withResolvers<void>()
    const waitMethod = TERMINAL_LIFECYCLE_METHODS.find((method) => method.name === 'terminal.wait')
    if (!waitMethod) {
      throw new Error('original terminal.wait declaration missing')
    }
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [
        waitMethod,
        defineMethod({
          name: 'worktree.list',
          permission: 'workspace',
          params: z.object({}),
          handler: async () => {
            shortEntered.resolve()
            await shortFinish.promise
            return {}
          }
        })
      ]
    })
    const call = async (request: RpcRequest, signal?: AbortSignal) => {
      if (transport === 'dispatch') {
        return dispatcher.dispatch(request, { signal })
      }
      const replies: string[] = []
      await dispatcher.dispatchStreaming(request, (reply) => replies.push(reply), { signal })
      return JSON.parse(replies[0]!)
    }
    const abort = new AbortController()
    const pending = call(
      {
        authToken: '',
        id: 'wait',
        method: 'terminal.wait',
        params: { terminal: 'term_probe', for: 'exit' }
      },
      abort.signal
    )
    try {
      await entered.promise
      expect(waiters.get('term_probe')?.size).toBe(1)
      expect([...waiters.get('term_probe')!][0].timeout).toBeNull()
      setStructuredJournalReadiness(() => false)
      await initializer.advance(structuredJournalBackgroundReady)
      expect(initialized).not.toHaveBeenCalled()
      setStructuredJournalReadiness(() => true)
      const short = call({ authToken: '', id: 'short', method: 'worktree.list', params: {} })
      await shortEntered.promise
      expect(structuredJournalBackgroundReady()).toBe(false)
      await initializer.advance(structuredJournalBackgroundReady)
      expect(initialized).not.toHaveBeenCalled()
      expect(readJournalRestFacts(database.db, sessionId)).toMatchObject({
        known: false,
        openTurn: null
      })
      shortFinish.resolve()
      expect(await short).toMatchObject({ ok: true })
      expect(structuredJournalBackgroundReady()).toBe(true)
      await initializer.advance(structuredJournalBackgroundReady)
      expect(initialized).toHaveBeenCalledOnce()
      expect(readJournalRestFacts(database.db, sessionId)).toMatchObject({
        known: true,
        openTurn: { since: 100 }
      })
      expect(waiters.get('term_probe')?.size).toBe(1)
      expect(failed).not.toHaveBeenCalled()
    } finally {
      shortFinish.resolve()
      abort.abort()
      expect(await pending).toMatchObject({ ok: false })
      await initializer.close()
    }
  }
)

it.each(['dispatch', 'streaming'] as const)(
  'holds before asynchronous admission, releases failures and observes finite launch over %s',
  async (transport) => {
    const runtime = new OrcaRuntimeService()
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      rendererGeneration: 'admission',
      startupRestorationReady: true
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [
        defineMethod({
          name: 'agent.launch',
          permission: 'workspace',
          params: z.object({ prompt: z.string() }),
          handler: async () => {
            expect(structuredJournalBackgroundReady()).toBe(false)
            entered.resolve()
            await release.promise
            throw new Error('finite launch failure')
          }
        })
      ]
    })
    const call = (request: RpcRequest) =>
      transport === 'dispatch'
        ? dispatcher.dispatch(request)
        : dispatcher.dispatchStreaming(request, () => undefined)
    const pending = call({
      id: 'launch',
      authToken: '',
      method: 'agent.launch',
      params: { prompt: 'recorded fixture' }
    })
    expect(structuredJournalBackgroundReady()).toBe(false)
    await entered.promise
    expect(structuredJournalBackgroundReady()).toBe(false)
    release.resolve()
    await pending
    expect(structuredJournalBackgroundReady()).toBe(true)
    await call({ authToken: '', id: 'reject', method: 'agent.launch', params: {} })
    expect(structuredJournalBackgroundReady()).toBe(true)
  }
)

it('releases passive streaming admission before the persistent receive phase', async () => {
  const runtime = new OrcaRuntimeService()
  runtime.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    rendererGeneration: 'passive',
    startupRestorationReady: true
  })
  const entered = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<void>()
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [
      defineStreamingMethod({
        name: 'layout.subscribe',
        permission: 'workspace',
        params: z.object({}),
        handler: async () => {
          entered.resolve()
          await closed.promise
        }
      })
    ]
  })
  const pending = dispatcher.dispatchStreaming(
    { authToken: '', id: 'persistent', method: 'layout.subscribe', params: {} },
    () => undefined
  )
  await entered.promise
  expect(structuredJournalBackgroundReady()).toBe(true)
  closed.resolve()
  await pending
})

it('observes finite terminal input through settlement and releases a failed write', async () => {
  const runtime = new OrcaRuntimeService()
  setStructuredJournalReadiness(() => true)
  const entered = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const send = vi.spyOn(runtime, 'sendTerminal').mockImplementation(async () => {
    entered.resolve()
    await finish.promise
    throw new Error('actual write failed')
  })
  const input = sendTerminalStreamInput(runtime, {
    terminal: 'term_probe',
    text: 'recorded input',
    client: undefined,
    isMobile: false
  })
  await entered.promise
  expect(structuredJournalBackgroundReady()).toBe(false)
  finish.resolve()
  expect(await input).toBe('failed')
  expect(structuredJournalBackgroundReady()).toBe(true)
  expect(send).toHaveBeenCalledOnce()
})
