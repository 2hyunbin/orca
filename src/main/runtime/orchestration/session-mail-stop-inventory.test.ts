import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from '../../sqlite/sync-database'
import { foundAgentSessionRecord } from '../agent-session-record-founding'
import { OrchestrationDb } from './db'
import { captureSessionMailAtStop } from './session-mail-stop-inventory'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { formatOrcaSessionAddress } from '../../../shared/orca-session-address'

const id = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const address = formatOrcaSessionAddress(id)
const record = foundAgentSessionRecord(
  {
    sessionId: id,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/tmp/unused' },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder',
      workspaceKind: 'folder'
    }
  },
  { claimKeyId: 'key', now: 1 }
)
const roots: string[] = []
const databases: { close: () => void }[] = []
afterEach(() => {
  vi.restoreAllMocks()
  databases
    .splice(0)
    .toReversed()
    .forEach((db) => db.close())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
function harness() {
  const root = mkdtempSync(join(tmpdir(), 'pr28567-stop-inventory-'))
  roots.push(root)
  const path = join(root, 'mail.db')
  const db = new OrchestrationDb(path)
  databases.push(db)
  const peer = new Database(path)
  peer.pragma('busy_timeout = 0')
  databases.push(peer)
  return { db, peer, capture: () => captureSessionMailAtStop(db, id, [record], vi.fn()) }
}

it('captures the complete committed unreserved/held/heartbeat inventory, holding its own reservation until the journal finishes', () => {
  const { db, peer, capture } = harness()
  const run = db.createRun({
    objective: 'run',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: id
  })
  const first = db.insertMessage({
    from: 'worker',
    to: `run:${run.id}`,
    subject: 'A',
    runId: run.id
  })
  const second = db.insertMessage({ from: 'worker', to: address, subject: 'B' })
  const heartbeat = db.insertMessage({
    from: 'worker',
    to: address,
    subject: 'heartbeat',
    type: 'heartbeat'
  })
  db.db
    .prepare('UPDATE messages SET handoff = ? WHERE id = ?')
    .run('{"version":1,"kind":"unknown"}', first.id)
  const captured = capture()
  expect(new Set(captured.members)).toEqual(new Set([first.id, second.id, heartbeat.id]))
  expect(() => peer.exec('BEGIN IMMEDIATE')).toThrow()
  captured.finished?.()
  expect(db.db.isTransaction).toBe(false)
  expect(db.db.pragma('busy_timeout', { simple: true })).toBe(5000)
  peer.exec('BEGIN IMMEDIATE')
  peer.exec('ROLLBACK')
  const fresh = db.insertMessage({ from: 'worker', to: address, subject: 'C' })
  expect(captured.members).not.toContain(fresh.id)
})

it('returns UNKNOWN on busy, nested, absent or incomplete ownership without changing another transaction', () => {
  const { db, peer, capture } = harness()
  peer.exec('BEGIN IMMEDIATE')
  expect(capture().members).toBeUndefined()
  expect(peer.isTransaction).toBe(true)
  peer.exec('ROLLBACK')
  db.db.exec('BEGIN IMMEDIATE')
  db.insertMessage({ from: 'worker', to: address, subject: 'provisional' })
  expect(capture().members).toBeUndefined()
  expect(db.db.isTransaction).toBe(true)
  db.db.exec('ROLLBACK')
  expect(captureSessionMailAtStop(null, id, [record], vi.fn()).members).toBeUndefined()
  expect(captureSessionMailAtStop(db, id, [], vi.fn()).members).toBeUndefined()
  expect(db.db.isTransaction).toBe(false)
})

it('uses current generation ownership and pending direct routing, so later ownership acquisition is new to its recipient', () => {
  const { db, capture } = harness()
  const run = db.createRun({
    objective: 'other',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: id
  })
  const deferred = db.insertMessage({
    from: 'worker',
    to: 'old-coordinator',
    subject: 'deferred',
    runId: run.id
  })
  db.rememberRunCoordinatorHandle(run.id, 'old-coordinator')
  const captured = capture()
  expect(captured.members).toContain(deferred.id)
  captured.finished?.()
  db.db
    .prepare('UPDATE runs SET consumer_generation = consumer_generation + 1 WHERE id = ?')
    .run(run.id)
  const stale = capture()
  expect(stale.members).not.toContain(deferred.id)
  stale.finished?.()
  expect(db.getMessageById(deferred.id)?.to_handle).toBe('old-coordinator')
  db.bindRun({
    runId: run.id,
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: id
  })
  const acquired = capture()
  expect(acquired.members).toContain(deferred.id)
  acquired.finished?.()
  expect(stale.members).not.toContain(deferred.id)
})

it('captures worker Dispatch and foreign direct ownership from durable reminted-pane identity, independently of a live registry', () => {
  const { db, capture } = harness()
  const run = db.createRun({
    objective: 'worker run',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  })
  const task = db.createTask({ runId: run.id, spec: 'work' })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 5,
    taskId: task.id,
    startOptions: {}
  })
  const handle = mintStructuredWorkerHandle()
  const paneKey = mintStructuredWorkerPaneKey(id)
  db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle,
    paneKey,
    processIncarnation: structuredWorkerProcessIncarnation(id),
    worktreeId: 'folder',
    effects: [],
    setupState: 'not_applicable',
    hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
    terminalOwnership: 'created'
  })
  const pending = db.insertMessage({
    from: 'coordinator',
    to: handle,
    subject: 'direct tail',
    runId: run.id
  })
  const assigned = db.insertMessage({
    from: 'coordinator',
    to: `dispatch:${started.dispatch.id}`,
    subject: 'dispatch',
    runId: run.id
  })
  const before = capture()
  expect(new Set(before.members)).toEqual(new Set([pending.id, assigned.id]))
  before.finished?.()
  db.db
    .prepare('UPDATE dispatch_contexts SET assignee_handle = ? WHERE id = ?')
    .run('reminted', started.dispatch.id)
  const reminted = capture()
  expect(new Set(reminted.members)).toEqual(new Set([pending.id, assigned.id]))
  reminted.finished?.()
})
