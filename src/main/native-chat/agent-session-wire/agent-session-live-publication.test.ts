import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { createTrackedJournalOpener, openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { replayJournal } from '../agent-session-journal/journal-open'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'

const SESSION = 'live-publication'
const options = { fence: 1, turnScope: { kind: 'thread' } } as const
const identity = { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 0 } as const
const journals = createTrackedJournalOpener()
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'orca-live-publication-')) })
afterEach(async () => { vi.restoreAllMocks(); await journals.closeAll(); await rm(root, { recursive: true, force: true }) })
function open() {
  return journals.open({ identity: { sessionId: SESSION, workspaceId: 'workspace', hostId: 'local',
    agent: 'codex', providerHandle: codexProviderHandle('thread') }, stateDirectory: root })
}

it('publishes committed text and all queue markers without hiding damage from saved readers', async () => {
  const journal = await open()
  const subscribers = new AgentSessionSubscribers()
  const events: AgentSessionSubscribeEvent[] = []
  subscribers.open({ id: 'live', sessionId: SESSION, journal, fence: 1, emit: (e) => events.push(e) })
  const prefix = 'x'.repeat(6000)
  await journal.appendItem(identity, { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: prefix }] }, options)
  subscribers.publish(SESSION, journal)
  const before = journal.cursor()
  await journal.appendItem(identity, { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: prefix + 'end' }] }, options)
  const db = openTestJournalHostDatabase(root).db
  const changed = db.prepare('UPDATE journal_text_pieces SET suffix = ? WHERE session_id = ? AND seq = ?').run('\\q', SESSION, before.sequence)
  expect(changed.changes).toBe(1)
  const saved = vi.spyOn(journal, 'readSince')
  subscribers.publish(SESSION, journal)
  expect(saved).not.toHaveBeenCalled()
  expect(events.at(-1)).toMatchObject({ type: 'batch', batch: { cursor: journal.cursor(), items: [
    { body: { blocks: [{ type: 'text', text: prefix + 'end' }] } }
  ] } })
  expect(journal.readSince(before)).toMatchObject({ ok: true, rows: [] })
  expect(replayJournal(db, SESSION)?.damage).toBeDefined()
  // Restore the fixture before checking the same stream's no-item markers and durable fallback.
  db.prepare('UPDATE journal_text_pieces SET suffix = ? WHERE session_id = ? AND seq = ?').run(prefix, SESSION, before.sequence)
  await journal.appendStopEvent({ reason: 'user-stop' }, 1)
  await journal.appendQueueResume(1)
  await journal.appendQueueReopen(1)
  await journal.context.clear({ operationId: 'clear', afterFence: 1, clearedAt: 1 },
    { write: () => {}, committed: () => {} }, 'clear')
  saved.mockClear()
  subscribers.publish(SESSION, journal)
  expect(saved).not.toHaveBeenCalled()
  expect(events.at(-1)).toMatchObject({ type: 'batch', batch: { cursor: journal.cursor(), removedItemIds: [] } })
  const lag = journal.cursor()
  for (let i = 0; i < 202; i++) await journal.appendQueueResume(1)
  subscribers.publish(SESSION, journal)
  expect(saved).toHaveBeenCalled()
  expect(events.at(-1)).toMatchObject({ type: 'batch', batch: { cursor: journal.cursor(), removedItemIds: [] } })
  saved.mockClear()
  subscribers.open({ id: 'reconnect', sessionId: SESSION, journal, fence: 1, cursor: lag, emit: () => {} })
  expect(saved).toHaveBeenCalled()
})

it('pins turn, prompts and working to the captured head when an earlier subscriber writes', async () => {
  const journal = await open()
  const prompt = { ...identity, ordinal: 1 }
  const promptId = agentJournalItemKey(prompt)
  await journal.appendItem(identity, { kind: 'turn', turnId: 'turn', state: 'running' }, options)
  await journal.appendItem(prompt, { kind: 'approval', title: 'Allow?', detail: null,
    options: [{ id: 'yes', label: 'Allow' }], resolution: {
      state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null } }, options)
  const subscribers = new AgentSessionSubscribers({ readCurrentWork: () => new StructuredAgentSessionCurrentWork(journal, 1) })
  let mutate = true
  const writes: Promise<unknown>[] = []
  const second: AgentSessionSubscribeEvent[] = []
  subscribers.open({ id: 'first', sessionId: SESSION, journal, fence: 1, emit: (event) => {
    if (event.type !== 'batch' || !mutate) return
    mutate = false
    writes.push(journal.appendItem(identity, { kind: 'turn', turnId: 'turn', state: 'completed' }, options))
    writes.push(journal.appendTombstone(prompt, { fence: 1 }))
  } })
  subscribers.open({ id: 'second', sessionId: SESSION, journal, fence: 1, emit: (event) => second.push(event) })
  await journal.appendItem({ ...identity, ordinal: 2 }, { kind: 'status', text: 'progress' }, options)
  const captured = journal.cursor()
  subscribers.publish(SESSION, journal)
  await Promise.all(writes)
  expect(second.at(-1)).toMatchObject({ type: 'batch', batch: { cursor: captured },
    latestTurn: { turn: { state: 'running' } }, actionablePromptIds: [promptId], working: true })
  subscribers.publish(SESSION, journal)
  expect(second.at(-1)).toMatchObject({ type: 'batch', batch: { cursor: journal.cursor(), removedItemIds: [promptId] },
    latestTurn: { turn: { state: 'completed' } }, actionablePromptIds: [], working: false })
})
