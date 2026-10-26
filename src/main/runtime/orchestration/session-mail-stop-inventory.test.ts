import { mailTestResources, observeMailSql } from './mail-handoff.test-fixture'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import Database from '../../sqlite/sync-database'
import { agentSessionRecordFixture } from '../../native-chat/agent-session-record-test-fixture'
import { OrchestrationDb } from './db'
import { captureSessionMailAtStop } from './session-mail-stop-inventory'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { formatOrcaSessionAddress } from '../../../shared/orca-session-address'

const id = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const address = formatOrcaSessionAddress(id)
const record = agentSessionRecordFixture({ sessionId: id })
const resources = mailTestResources('pr28567-stop-inventory-')
afterEach(() => vi.restoreAllMocks())
function harness() {
  const root = resources.directory()
  const path = join(root, 'mail.db')
  const db = resources.track(new OrchestrationDb(path))
  const peer = resources.track(new Database(path))
  peer.pragma('busy_timeout = 0')
  const sql = observeMailSql(
    db.db,
    /FROM dispatch_contexts|run_coordinator_handles WHERE/,
    'get',
    (call) => {
      expect(sql.explain(call.sql, call.args)).toContain('SEARCH')
    }
  )
  const capture = () => captureSessionMailAtStop(db, id, [record], vi.fn())
  const coordinator = { coordinatorHandle: null, coordinatorPaneKey: null }
  return { db, peer, capture, coordinator }
}

it('returns UNKNOWN on busy ownership without changing another transaction', () => {
  const { peer, capture } = harness()
  peer.exec('BEGIN IMMEDIATE')
  expect(capture().members).toBeUndefined()
  expect(peer.isTransaction).toBe(true)
  peer.exec('ROLLBACK')
})

it('captures worker Dispatch and foreign direct ownership from durable reminted-pane identity, independently of a live registry', () => {
  const { db, capture, coordinator } = harness()
  const run = db.createRun({ objective: 'worker run', ...coordinator })
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

it.each([100, 1000])(
  'captures all owed IDs with indexed direct routing and releases its exact writer at U=%i',
  (count) => {
    const { db, peer, capture, coordinator } = harness()
    const run = db.createRun({ objective: 'owned', ...coordinator, coordinatorOrcaSessionId: id })
    const deferred = db.insertMessage({
      from: 'worker',
      to: 'old-coordinator',
      subject: 'deferred',
      runId: run.id
    })
    db.rememberRunCoordinatorHandle(run.id, 'old-coordinator')
    const owed = [deferred.id]
    for (let index = 0; index < count; index++) {
      const row = db.insertMessage({
        from: 'sender',
        to: index % 2 ? address : `run:${run.id}`,
        runId: run.id,
        subject: String(index),
        type: index % 3 ? 'status' : 'heartbeat'
      })
      owed.push(row.id)
      db.insertMessage({ from: 'sender', to: 'unrelated', subject: String(index) })
    }
    db.db
      .prepare('UPDATE messages SET handoff = ? WHERE id = ?')
      .run('{"version":1,"kind":"unknown"}', owed[0])
    const queries = vi.spyOn(db.db, 'prepare')
    const probe = vi.spyOn(db, 'findActiveDispatchForDirectMessageOwner')
    const captured = capture()
    expect(new Set(captured.members)).toEqual(new Set(owed))
    expect(probe).toHaveBeenCalledTimes(count + 1)
    expect(
      queries.mock.calls.filter(([sql]) =>
        sql.includes('SELECT id, run_id, to_handle FROM messages')
      )
    ).toHaveLength(1)
    expect(() => peer.exec('BEGIN IMMEDIATE')).toThrow()
    captured.finished?.()
    expect(db.db.isTransaction).toBe(false)
    expect(db.db.pragma('busy_timeout', { simple: true })).toBe(5000)
    peer.exec('BEGIN IMMEDIATE')
    peer.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(owed[1])
    peer.exec('COMMIT')
    const next = capture()
    expect(next.members).toHaveLength(count)
    next.finished?.()
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
  }
)
