import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { selectTerminalMailHandoff } from './terminal-mail-settlement'
import { OrchestrationDb } from './db/orchestration-db'
import { OrchestrationMailboxOwner, type OrchestrationMailboxLeaf } from './mailbox-owner'

let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

function leafFor(tabId: string, leafId: string): OrchestrationMailboxLeaf {
  return {
    tabId,
    leafId,
    ptyId: `pty_${leafId}`,
    writable: true,
    lastAgentStatus: 'idle',
    lastAgentStatusObservedLive: true,
    lastOscTitle: null
  }
}

function ownerFor(database: OrchestrationDb): OrchestrationMailboxOwner {
  return new OrchestrationMailboxOwner({
    getDb: () => database,
    getLeaf: () => undefined,
    getLeafKey: (tabId, leafId) => `${tabId}:${leafId}`,
    getTerminalHandleForLeafKey: (leafKey) => `term_${leafKey}`,
    getTerminalProcessIncarnation: () => 'process_worker',
    onRoutedMessageTypes: () => {},
    onForeignMailboxRouted: () => {}
  })
}

function attachRemoteDispatch(
  database: OrchestrationDb,
  paneKey: string,
  dispatchId = 'ctx_remote',
  runId = 'run-home'
): void {
  database.createRemoteDispatchAttachment({
    runId,
    dispatchId,
    taskId: 'task_remote',
    homePeerFingerprint: 'home_peer',
    protocolVersion: 1,
    runtimeEpoch: 'worker_epoch',
    mutationReceipt: {
      callerFingerprint: 'home_peer',
      requestId: 'remote_start',
      method: 'orchestration.federationAttachStart',
      payloadHash: 'remote_payload'
    }
  })
  database.prepareRemoteAttachmentAuthority({
    dispatchId,
    paneKey,
    processIncarnation: 'process_worker',
    worktreeId: 'repo::worktree',
    terminalHandle: `term_${paneKey}`,
    setupState: 'not_applicable',
    effects: []
  })
}

describe('OrchestrationMailboxOwner.resolve', () => {
  // Why: every idle agent title re-resolves its pane's mailbox, so a statement the SQLite cache
  // refuses (a `SELECT *`) recompiles on each title while output streams.
  it.each([
    ['a plain pane', false],
    ['a pane with a remote Dispatch', true]
  ])('reuses every statement it prepares for %s', (_label, attached) => {
    db = new OrchestrationDb(':memory:')
    const leaf = leafFor('tab_a', 'leaf_a')
    if (attached) {
      attachRemoteDispatch(db, 'tab_a:leaf_a')
    }
    const owner = ownerFor(db)
    const prepare = db.db.prepare.bind(db.db)
    const prepared = new Set<string>()
    vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
      prepared.add(sql)
      return prepare(sql)
    })

    const mailbox = owner.resolve(leaf)

    expect(mailbox).toBe(attached ? 'dispatch:ctx_remote' : 'term_tab_a:leaf_a')
    expect(prepared.size).toBeGreaterThan(0)
    for (const sql of prepared) {
      expect(prepare(sql), sql).toBe(prepare(sql))
    }
  })
})

it.each(['attachment-only', 'attachment-loopback', 'local-loopback'] as const)(
  'fences automatic input, check and ack by the actual routed %s source',
  (mode) => {
    db = new OrchestrationDb(':memory:')
    const leaf = leafFor('tab_a', 'leaf_a')
    const pane = 'tab_a:leaf_a'
    const run = db.createRun({
      objective: 'authority',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: 'coord:pane'
    })
    const local =
      mode !== 'attachment-only'
        ? createRootDispatch(
            db,
            db.createTask({ runId: run.id, spec: 'loopback' }).id,
            'local',
            mode === 'local-loopback' ? pane : 'other:pane'
          )
        : null
    const id = local?.id ?? 'ctx_remote'
    attachRemoteDispatch(db, mode === 'local-loopback' ? 'remote:pane' : pane, id, run.id)
    const mailbox = `dispatch:${id}`
    expect(ownerFor(db).resolve(leaf)).toBe(mailbox)
    const attachment = mode !== 'local-loopback'
    const params = {
      runId: run.id,
      mailboxHandle: mailbox,
      consumerGeneration: attachment ? 1 : local!.consumer_generation,
      consumerSource: attachment ? ('attachment' as const) : ('dispatch' as const)
    }
    db.insertMessage({ runId: run.id, from: 'sender', to: mailbox, subject: 'already checked' })
    const delivery = db.getOrCreateMailboxDelivery(params)!.delivery
    const message = db.insertMessage({
      runId: run.id,
      from: 'sender',
      to: mailbox,
      subject: 'fresh'
    })
    const select = () =>
      selectTerminalMailHandoff({
        db: db!,
        mailbox,
        route: pane,
        target: null,
        wasAbandoned: () => false,
        waiters: undefined,
        reservedTypes: undefined
      })
    const reserved = select()
    expect(reserved.map((row) => row.id)).toEqual([message.id])
    const authority = db.mailboxHandoffAuthority(mailbox, pane)
    if (local) {
      db.db
        .prepare(
          attachment
            ? 'UPDATE dispatch_contexts SET consumer_generation = consumer_generation + 1 WHERE id = ?'
            : 'UPDATE remote_dispatch_attachments SET consumer_generation = consumer_generation + 1 WHERE dispatch_id = ?'
        )
        .run(id)
      expect(db.isMailHandoffCurrent(mailbox, reserved, authority)).toBe(true)
      expect(db.getOrCreateMailboxDelivery(params)?.delivery.id).toBe(delivery.id)
    }
    db.db
      .prepare(
        attachment
          ? 'UPDATE remote_dispatch_attachments SET consumer_generation = consumer_generation + 1 WHERE dispatch_id = ?'
          : 'UPDATE dispatch_contexts SET consumer_generation = consumer_generation + 1 WHERE id = ?'
      )
      .run(id)
    expect(db.isMailHandoffCurrent(mailbox, reserved, authority)).toBe(false)
    expect(() => db!.getOrCreateMailboxDelivery(params)).toThrow(
      expect.objectContaining({ code: 'consumer_fenced' })
    )
    expect(() => db!.acknowledgeMailboxDelivery({ ...params, deliveryId: delivery.id })).toThrow(
      expect.objectContaining({ code: 'consumer_fenced' })
    )
    const adopted = select()
    expect(adopted.map((row) => row.id)).toEqual([message.id])
    expect(adopted[0]?.recovery_used).toBe(0)
    expect(db.getMessageById(message.id)?.read).toBe(0)
  }
)
