// A Codex chat is Working while Codex still holds a send, never while Orca merely waits for a
// delivery row: a turn that completes without taking a send (a hook blocked it) ends Working with
// no row written, and a client already following the chat reads it from the frames it is sent.
// Driven through the shipped host, journal and Codex adapter; only the Codex child is fake.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import { codexTurnLifecycleFake } from '../codex/codex-turn-lifecycle-fake'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'
import { hasUnansweredStructuredAgentSessionDispatch } from '../../shared/structured-agent-session-unanswered-dispatch'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { scriptedCodexTransport } from './scripted-codex-transport.test-fixture'
import { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import {
  closeTestJournalHostDatabase,
  liveTestJournalRows,
  loadTestJournal
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import type Database from '../sqlite/sync-database'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  agentJournalSendAnsweredKey
} from '../../shared/agent-session-journal-item-key'
import { codexTurnLifecycleIdentity } from '../codex/codex-structured-journal-translation-turns'

// The retained-observation bound, shrunk by the loss case; the held-send bound keeps its own.
const observationBound = vi.hoisted(() => ({ value: 256 }))
vi.mock('../codex/codex-structured-dispatch-echo', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get MAX_CODEX_PENDING_DISPATCH_ECHOES() {
    return observationBound.value
  }
}))

const CALLER = { callerKey: 'codex-held-sends-test' }

let root: string
let host: StructuredAgentSessionHost
let fence: number
let handlers: CodexAppServerConnectionHandlers | undefined
let answers: number
let steers: number
let closes: number
/** Holds every `turn/steer` answer until it resolves. */
let steerHold: Promise<void> | null
let turns: ReturnType<typeof codexTurnLifecycleFake>
let operations = 0
const events: AgentSessionSubscribeEvent[] = []

const operationId = (): string => `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`

async function send(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const fields = { body }
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: operationId(),
      expectedRuntimeFence: fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields
      })
    },
    body
  })
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  return sent.value.clientMessageId
}

/** The send as the newest frame that carried it told the subscriber. */
function lastPublished(clientMessageId: string): AgentJournalSubmission | undefined {
  for (const event of events.toReversed()) {
    const submissions =
      event.type === 'batch'
        ? event.batch.submissions
        : event.type === 'snapshot' || event.type === 'reset'
          ? event.page.submissions
          : []
    const found = submissions.find((entry) => entry.clientMessageId === clientMessageId)
    if (found) {
      return found
    }
  }
  return undefined
}

async function rawSubmission(clientMessageId: string): Promise<AgentJournalSubmission> {
  await host.flushStreamedEvents(SESSION)
  const snapshot = await host.journalSnapshot(SESSION)
  const found = snapshot.submissions.find((entry) => entry.clientMessageId === clientMessageId)
  if (!found) {
    throw new Error(`no submission ${clientMessageId}`)
  }
  return found
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-held-sends-'))
  answers = 0
  steers = 0
  closes = 0
  steerHold = null
  observationBound.value = 256
  events.length = 0
  turns = codexTurnLifecycleFake(
    THREAD,
    () => (method, params) => handlers?.onNotification?.(method, params)
  )
  const openConnection: typeof openCodexAppServerConnection = async (
    _launch,
    connectionHandlers = {}
  ) => {
    handlers = connectionHandlers
    const connection: CodexAppServerConnection = {
      pid: 4321,
      closed: false,
      request: async (method, params) => {
        if (method === 'thread/start' || method === 'thread/resume') {
          return { thread: { id: THREAD } }
        }
        if (method === 'turn/start') {
          answers += 1
          return turns.routes['turn/start']()
        }
        if (method === 'turn/steer') {
          steers += 1
          const steered = turns.routes['turn/steer'](params)
          return steerHold ? steerHold.then(() => steered) : steered
        }
        return {}
      },
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => {
        closes += 1
        return true
      }
    }
    return connection
  }
  host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    resolveCodexCommand: () => 'codex',
    resolveEnvironment: async () => ({ PATH: process.env.PATH }),
    ...scriptedCodexTransport(openConnection)
  })
  const attachParams = hostTestAttachParams(null, { providerHandle: undefined })
  attachParams.envelope.clientOperationId = operationId()
  const attached = await host.attach(CALLER, attachParams)
  if (!attached.ok) {
    throw new Error(JSON.stringify(attached.refusal))
  }
  fence = attached.value.fence
  await host.subscribe({
    id: 'old-client',
    sessionId: SESSION,
    emit: (event) => events.push(event)
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await stopStructuredAgentSessionRuntime()
  closeTestJournalHostDatabase(root)
  await rm(root, { recursive: true, force: true })
})

/** Fails every journal transaction `fails` picks, by the rows it would commit for the chat. */
function failJournalWrites(fails: (rows: Record<string, unknown>[]) => boolean): void {
  const transaction = JournalHostDatabase.prototype.transaction
  vi.spyOn(JournalHostDatabase.prototype, 'transaction').mockImplementation(function <T>(
    this: JournalHostDatabase,
    run: (db: Database.Database) => T,
    streamed?: boolean
  ): T {
    const checked = (db: Database.Database): T => {
      const before = liveTestJournalRows(db, SESSION).length
      const result = run(db)
      const rows = liveTestJournalRows(db, SESSION)
        .slice(before)
        .map((row): Record<string, unknown> => JSON.parse(row.rowJson))
      if (fails(rows)) {
        throw new Error('journal write failed')
      }
      return result
    }
    return transaction.bind(this)(checked, streamed)
  })
}

/** A receipt saved on its own, with no turn row beside it. */
function bareReceipt(rows: Record<string, unknown>[], clientMessageId: string): boolean {
  return (
    rows.some(
      (row) =>
        row.kind === 'dispatch' &&
        row.state === 'accepted' &&
        row.clientMessageId === clientMessageId
    ) && !rows.some((row) => row.kind === 'item' || row.kind === 'lifecycle-batch')
  )
}

function turnBody(items: Iterable<{ body: AgentJournalItemBody }>, turnId: string) {
  return [...items].find((item) => item.body.kind === 'turn' && item.body.turnId === turnId)?.body
}

const TURN_ITEM_ID = agentJournalItemKey(codexTurnLifecycleIdentity(SESSION, 'turn-1'))

describe('a Codex send whose turn completes without taking it', () => {
  it('allows /compact afterwards without returning or publishing an unconfirmed command', async () => {
    const blocked = await send('a hook blocks this prompt')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    turns.end('completed')
    await vi.waitFor(() => expect(host.currentWork(SESSION)?.working()).toBe(false))
    expect((await rawSubmission(blocked)).dispatchState).toBe('pending')

    const command = 'compact' as const
    const result = await host.conversationCommand(CALLER, {
      command,
      envelope: {
        sessionId: SESSION,
        clientOperationId: operationId(),
        expectedRuntimeFence: fence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.conversationCommand',
          sessionId: SESSION,
          fields: { command }
        })
      }
    })
    expect(result).toMatchObject({ ok: true, value: { command, state: 'completed' } })
    expect(result).not.toHaveProperty('value.error')
    await vi.waitFor(() => expect(host.currentWork(SESSION)?.activeTurnId()).toMatch(/^compact:/))
    const snapshot = await host.journalSnapshot(SESSION)
    const compact = snapshot.submissions.find((entry) => entry.clientMessageId !== blocked)
    if (!compact) {
      throw new Error('missing command submission')
    }
    await vi.waitFor(async () =>
      expect((await rawSubmission(compact.clientMessageId)).dispatchState).toBe('accepted')
    )
    const states = events
      .flatMap((event) => (event.type === 'batch' ? event.batch.submissions : []))
      .filter((entry) => entry.clientMessageId === compact.clientMessageId)
    expect(states.length).toBeGreaterThan(0)
    expect(states.every((entry) => entry.dispatchState !== 'unknown' && !entry.recovered)).toBe(
      true
    )

    handlers?.onNotification?.('turn/started', {
      threadId: THREAD,
      turn: { id: 'turn-compact', status: 'inProgress' }
    })
    handlers?.onNotification?.('item/completed', {
      threadId: THREAD,
      turnId: 'turn-compact',
      item: { type: 'contextCompaction', id: 'compact' }
    })
    handlers?.onNotification?.('turn/completed', {
      threadId: THREAD,
      turn: { id: 'turn-compact', status: 'completed' }
    })
    await vi.waitFor(() => expect(host.currentWork(SESSION)?.working()).toBe(false))
    expect((await host.journalSnapshot(SESSION)).items).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          kind: 'turn',
          turnId: expect.stringMatching(/^compact:/),
          state: 'completed'
        })
      })
    )
  })

  it('stops being Working with no row written, for the host and a client already following', async () => {
    const blocked = await send('a hook blocks this prompt')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    await vi.waitFor(() => expect(host.currentWork(SESSION)?.working()).toBe(true))

    // Codex completes the turn and never echoes the prompt: a hook refused it.
    turns.end('completed')

    await vi.waitFor(() => expect(host.currentWork(SESSION)?.working()).toBe(false))
    // No delivery row was needed: the journal still has the handover alone.
    expect((await rawSubmission(blocked)).dispatchState).toBe('pending')
    // A client that predates the host's working field reads the send it was sent.
    await vi.waitFor(() =>
      expect(lastPublished(blocked)).toMatchObject({ dispatchState: 'unknown', recovered: true })
    )
    const published = lastPublished(blocked)
    expect(published && hasUnansweredStructuredAgentSessionDispatch([published], fence)).toBe(false)

    const later = await send('second succeeds')
    await vi.waitFor(() => expect(answers).toBe(2))
    turns.start()
    turns.echo(later)
    turns.end('completed')
    await vi.waitFor(async () =>
      expect((await rawSubmission(later)).dispatchState).toBe('accepted')
    )
    handlers?.onExit?.(new Error('codex exited'))
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    )
    expect(
      (await host.journalSnapshot(SESSION)).items.some(
        (item) => item.body.kind === 'status' && item.body.failure
      )
    ).toBe(false)
  })

  it('keeps a send Working while Codex holds it, and its echo still settles it', async () => {
    const taken = await send('look around')
    await vi.waitFor(() => expect(answers).toBe(1))
    // Answered into a turn that has not opened yet: Codex holds it.
    expect(host.currentWork(SESSION)?.working()).toBe(true)
    turns.start()
    turns.echo(taken)
    turns.end('completed')

    await vi.waitFor(async () =>
      expect((await rawSubmission(taken)).dispatchState).toBe('accepted')
    )
    expect(host.currentWork(SESSION)?.working()).toBe(false)
  })
})

describe('what Codex said about a send, saved whatever its own write did', () => {
  it.each(['dies on its own', 'is closed by quitting Orca'])(
    'saves a failed receipt with its turn end and a failed answer when Codex %s, by exact id',
    async (exit) => {
      const a = await send('the same words')
      await vi.waitFor(() => expect(answers).toBe(1))
      turns.start()
      let releaseSteer = (): void => {}
      steerHold = new Promise<void>((resolve) => {
        releaseSteer = resolve
      })
      const b = await send('the same words')
      await vi.waitFor(() => expect(steers).toBe(1))
      const failed = { receipts: 0, marks: 0 }
      failJournalWrites((rows) => {
        if (bareReceipt(rows, b)) {
          failed.receipts += 1
          return true
        }
        const mark = rows.some((row) => row.itemId === agentJournalSendAnsweredKey(b))
        if (mark && failed.marks === 0) {
          failed.marks = 1
          return true
        }
        return false
      })

      // One stdout read: B's first echo prunes its held entry, and the turn ends after both echoes.
      const echo = {
        threadId: THREAD,
        turnId: 'turn-1',
        item: { type: 'userMessage', id: 'item-b', clientId: b, content: [] }
      }
      handlers?.onNotification?.('item/started', echo)
      handlers?.onNotification?.('item/completed', echo)
      turns.end('completed')

      await vi.waitFor(async () => expect((await rawSubmission(b)).dispatchState).toBe('accepted'))
      expect(failed.receipts).toBeGreaterThan(0)
      expect(closes).toBe(0)
      expect(lastPublished(b)).toMatchObject({ dispatchState: 'accepted' })
      expect(turnBody((await host.journalSnapshot(SESSION)).items, 'turn-1')).toMatchObject({
        endedBy: 'provider',
        receiptsComplete: true
      })

      // B's steer is answered after its turn ended, and that mark's first save fails.
      releaseSteer()
      await vi.waitFor(() => expect(failed.marks).toBe(1))
      if (exit === 'dies on its own') {
        handlers?.onExit?.(new Error('codex exited'))
        await vi.waitFor(async () =>
          expect((await rawSubmission(a)).dispatchState).not.toBe('pending')
        )
      }
      // A quit's close ends the child itself, before Codex's own report of that exit is settled.
      await stopStructuredAgentSessionRuntime()

      const reopened = loadTestJournal(root, SESSION)?.state
      expect(reopened?.submissions.get(b)).toMatchObject({
        dispatchState: 'accepted',
        providerItemId: expect.stringMatching(/^codex:/)
      })
      expect(reopened?.submissions.get(a)?.dispatchState).not.toBe('accepted')
      expect(reopened?.sendAnswers.get(b)).toBe(TURN_ITEM_ID)
      expect(turnBody(reopened?.items.values() ?? [], 'turn-1')).toMatchObject({
        endedBy: 'provider',
        receiptsComplete: true
      })
      expect(answers).toBe(1)
    }
  )

  it('drops the oldest unsaved receipt past the bound, and its turn certifies nothing', async () => {
    observationBound.value = 1
    const a = await send('first')
    await vi.waitFor(() => expect(answers).toBe(1))
    turns.start()
    const b = await send('second')
    await vi.waitFor(() => expect(steers).toBe(1))
    failJournalWrites((rows) => bareReceipt(rows, a) || bareReceipt(rows, b))

    // A's receipt is kept once Codex lets A go; B's, while B is still held, overflows it.
    turns.echo(a)
    turns.echo(b)
    turns.end('completed')

    await vi.waitFor(async () => expect((await rawSubmission(b)).dispatchState).toBe('accepted'))
    expect((await rawSubmission(a)).dispatchState).toBe('pending')
    expect(closes).toBe(0)
    await stopStructuredAgentSessionRuntime()
    const turn = turnBody(loadTestJournal(root, SESSION)?.state.items.values() ?? [], 'turn-1')
    expect(turn).toMatchObject({ endedBy: 'provider' })
    expect(turn).not.toHaveProperty('receiptsComplete')
  })
})
