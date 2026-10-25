import type * as WorkerThreads from 'node:worker_threads'
import type * as WorkerThreadEntryPath from '../../worker-thread-entry-path'
import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { serialize } from 'node:v8'
import { afterEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { openAgentSessionJournal } from './journal-store-factory'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabases
} from './journal-host-database-test-support'
import { readJournalRestFacts } from './journal-row-table'
import { replayLegacyRestChunk } from './journal-legacy-rest-replay'
import { WorkerThreadRequestQueue } from '../../worker-thread-request-queue'
import { openLegacyRestReader } from './journal-legacy-rest-reader'
import {
  JournalStructuralScratch,
  type JournalStructuralCheckpoint
} from './journal-structural-scratch'
import { legacyRestScratchPath } from './journal-legacy-rest-scratch'
import { LegacyRestSourceOwner } from './journal-legacy-rest-source'
import { JournalLegacyRestWorker } from './journal-legacy-rest-worker'
import { JournalLegacyRestInitializer } from './journal-legacy-rest-initializer'

const observed = vi.hoisted(() => {
  const workers: WorkerThreads.Worker[] = []
  return { workers, entry: '' }
})
vi.mock('../../worker-thread-entry-path', async (original) => {
  const actual = await original<typeof WorkerThreadEntryPath>()
  return { ...actual, resolveWorkerThreadEntryPath: () => observed.entry }
})
vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof WorkerThreads>()
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        expect(observed.workers.filter((worker) => worker.threadId !== -1)).toHaveLength(0)
        super(...args)
        observed.workers.push(this)
      }
    }
  }
})
let root = ''
const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0)) {
    await close()
  }
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
  observed.workers.length = 0
})

it('uses a readonly real thread, preserves displaced progress, retries a committed scratch crash and retires before replacement', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-legacy-worker-'))
  const emitted = join(root, 'journal-legacy-rest-worker-entry.cjs')
  await build({
    entryPoints: [resolve(__dirname, 'journal-legacy-rest-worker-entry.ts')],
    outfile: emitted,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node26',
    logLevel: 'error'
  })
  // Fault after the real scratch COMMIT, before the real reply. The production entry is unchanged.
  const failOnce = join(root, 'fail-after-scratch-commit')
  observed.entry = join(root, 'fault-bootstrap.cjs')
  await writeFile(
    observed.entry,
    `const fs = require('node:fs');
const { parentPort } = require('node:worker_threads');
const send = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (response) => {
  if (response.cursor > 0 && response.status === 'progress' && fs.existsSync(${JSON.stringify(failOnce)})) {
    fs.unlinkSync(${JSON.stringify(failOnce)});
    throw new Error('test crash after committed scratch');
  }
  send(response);
};
require(${JSON.stringify(emitted)});
`
  )
  const database = openTestJournalHostDatabase(root)
  for (const [id, count] of [
    ['hidden', 300],
    ['visible', 1],
    ['orphan', 1]
  ] as const) {
    const journal = await openAgentSessionJournal({
      database,
      now: () => 100,
      identity: {
        sessionId: id,
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle(id)
      }
    })
    await journal.appendItem(
      { provider: 'codex', threadId: id, turnId: 'root', ordinal: 0 },
      { kind: 'turn', turnId: 'root', state: 'running', startedAt: 100 },
      { fence: 1 }
    )
    for (let row = 0; row < count; row++) {
      await journal.appendItem(
        { provider: 'codex', threadId: id, turnId: 'root', ordinal: 1 },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: String(row) }] },
        { fence: 1 }
      )
    }
    await journal.close()
    database.db
      .prepare(
        'UPDATE journal_sessions SET open_turn_id=NULL, open_turn_since=NULL WHERE session_id=?'
      )
      .run(id)
  }
  const reader = openLegacyRestReader(root)
  expect(reader.pragma('query_only', { simple: true })).toBe(1)
  reader.pragma('query_only = OFF')
  expect(() => reader.prepare('UPDATE journal_sessions SET open_turn_since=999').run()).toThrow()
  expect(reader.pragma('journal_mode', { simple: true })).toBe('wal')
  reader.close()
  const publications: string[] = []
  const failed = vi.fn()
  let hiddenVisible = false
  let scans = 0
  let orphanRetired = false
  const owedKnown = new Set<string>()
  const deps = {
    database,
    candidates: function* () {
      scans++
      yield 'hidden'
      yield 'visible'
    },
    priority: (id: string) =>
      id === 'orphan'
        ? undefined
        : {
            visible: id === 'visible' || hiddenVisible,
            updatedAt: id === 'hidden' ? 200 : 100
          },
    owner: (id: string) => (id === 'orphan' && orphanRetired ? null : 'ended'),
    needsPublication: (id: string) => owedKnown.has(id),
    initialized: (id: string) => {
      publications.push(id)
      owedKnown.delete(id)
    },
    failed
  }
  const sourceOwner = new LegacyRestSourceOwner(deps)
  const control = new Int32Array(new SharedArrayBuffer(8))
  const seed = new JournalLegacyRestWorker(database, control)
  closes.push(() => seed.close())
  const source = sourceOwner.source('hidden')!
  const paused = { mode: 'replay', sessionId: 'hidden', source, generation: 0 } as const
  Atomics.store(control, 0, 1)
  expect((await seed.grant(paused)).status).toBe('paused')
  expect(existsSync(legacyRestScratchPath(root, 'hidden'))).toBe(false)
  Atomics.store(control, 0, 0)
  // Genuine old fixed-file progress, produced by the same canonical transaction, never renamed.
  const fixedPath = join(root, 'journal-rest-upgrade-scratch.db')
  const oldFixed = new JournalStructuralScratch(fixedPath)
  let oldProgress = replayLegacyRestChunk(database.db, oldFixed, 'hidden', source, () => true)
  while (oldProgress.cursor === 0) {
    oldProgress = replayLegacyRestChunk(database.db, oldFixed, 'hidden', source, () => true)
  }
  expect(oldProgress.cursor).toBeGreaterThan(0)
  oldFixed.close()
  let first = await seed.grant(paused)
  while (first.status === 'paused' && first.cursor <= oldProgress.cursor) {
    first = await seed.grant(paused)
  }
  expect(first.status).toBe('progress')
  expect(first.cursor).toBeGreaterThan(oldProgress.cursor)
  expect(first.cursor).toBeLessThan(source.tip)
  const savedReader = new JournalStructuralScratch(fixedPath)
  const saved = savedReader.load<JournalStructuralCheckpoint>()!
  expect(saved.cursor).toBe(first.cursor)
  const savedBytes = serialize(saved)
  savedReader.close()
  const orphan = await seed.grant({
    mode: 'replay',
    sessionId: 'orphan',
    source: sourceOwner.source('orphan')!,
    generation: 0
  })
  expect(orphan.status).toBe('complete')
  orphanRetired = true
  // A stale tip and generation cannot run or authorize the previously captured source.
  expect((await seed.grant({ ...paused, source: { ...source, tip: source.tip - 1 } })).status).toBe(
    'drift'
  )
  Atomics.add(control, 1, 1)
  expect((await seed.grant(paused)).status).toBe('paused')
  Atomics.store(control, 1, 0)
  await seed.close()
  expect(readJournalRestFacts(database.db, 'hidden')?.known).toBe(false)
  let initializer = new JournalLegacyRestInitializer(deps)
  closes.push(() => initializer.close())
  await initializer.advance(() => publications.length === 0)
  expect(publications).toEqual(['visible'])
  const displaced = new JournalStructuralScratch(fixedPath)
  expect(serialize(displaced.load())).toEqual(savedBytes)
  displaced.close()
  // Pair COMMIT survives retirement before cleanup; next launch publishes the saved pair, not replay.
  const visibleFacts = readJournalRestFacts(database.db, 'visible')
  await initializer.close()
  owedKnown.add('visible')
  initializer = new JournalLegacyRestInitializer(deps)
  await initializer.advance(() => publications.length < 2)
  expect(publications).toEqual(['visible', 'visible'])
  expect(readJournalRestFacts(database.db, 'visible')).toEqual(visibleFacts)
  const retained = new JournalStructuralScratch(fixedPath)
  expect(serialize(retained.load())).toEqual(savedBytes)
  retained.close()
  await writeFile(failOnce, '')
  hiddenVisible = true
  initializer.reconsider('hidden')
  await initializer.advance(() => true)
  expect(publications).toEqual(['visible', 'visible', 'hidden'])
  expect(failed).not.toHaveBeenCalled()
  expect(existsSync(failOnce)).toBe(false)
  expect(observed.workers.some((worker) => worker.threadId === -1)).toBe(true)
  expect(readJournalRestFacts(database.db, 'hidden')).toMatchObject({
    known: true,
    openTurn: { since: 100 }
  })
  const cleaned = new JournalStructuralScratch(fixedPath)
  expect(cleaned.load()).toBeUndefined()
  expect(cleaned.map('items').size).toBe(0)
  cleaned.close()
  const orphanScratch = new JournalStructuralScratch(legacyRestScratchPath(root, 'orphan'))
  expect(orphanScratch.load()).toBeUndefined()
  expect(orphanScratch.map('items').size).toBe(0)
  orphanScratch.close()
  expect(readJournalRestFacts(database.db, 'orphan')?.known).toBe(false)
  await initializer.advance(() => true)
  expect(scans).toBe(2)
  expect(publications).toEqual(['visible', 'visible', 'hidden'])
  await initializer.close()
  const invalid = new JournalLegacyRestWorker(database, control)
  const dispatch = vi.spyOn(WorkerThreadRequestQueue.prototype, 'dispatch')
  dispatch.mockResolvedValueOnce({ id: -1 })
  await expect(invalid.grant(paused)).rejects.toThrow('invalid or stale')
  dispatch.mockRestore()
  await invalid.close()
  // Rejected termination must not authorize another scratch owner even after helper teardown.
  const denied = new JournalLegacyRestWorker(database, control)
  Atomics.store(control, 0, 1)
  await denied.grant(paused)
  const owned = observed.workers.at(-1)!
  const spawns = observed.workers.length
  const terminate = vi
    .spyOn(owned, 'terminate')
    .mockRejectedValueOnce(new Error('unproved retirement'))
  await expect(denied.retire()).rejects.toThrow('unproved retirement')
  await expect(denied.grant(paused)).rejects.toThrow('unproved retirement')
  expect(observed.workers).toHaveLength(spawns)
  terminate.mockRestore()
  await owned.terminate()
  expect(observed.workers.every((worker) => worker.threadId === -1)).toBe(true)
}, 30_000)
