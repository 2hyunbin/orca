import '../../../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import type { RpcRequest } from '../../../core'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../../orchestration'

describe('orchestration federated message targeting', () => {
  let db: OrchestrationDb | undefined
  let runtime: OrcaRuntimeService | undefined

  afterEach(() => {
    runtime?.stopOrchestrationFederationRelay()
    db?.close()
  })

  it('rejects explicit send and ask targets without enqueueing a relay', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    const dispatchId = 'ctx_remote_targeting'
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const requests: RpcRequest[] = [
      request('send_to', 'orchestration.send', {
        from: 'term_remote_worker',
        to: 'run:explicit',
        subject: 'Wrong explicit target'
      }),
      request('send_run', 'orchestration.send', {
        from: 'term_remote_worker',
        run: 'run_explicit',
        subject: 'Wrong explicit Run'
      }),
      request('ask_to', 'orchestration.ask', {
        from: 'term_remote_worker',
        to: 'run:explicit',
        question: 'Wrong explicit target?'
      }),
      request('ask_run', 'orchestration.ask', {
        from: 'term_remote_worker',
        run: 'run_explicit',
        question: 'Wrong explicit Run?'
      })
    ]

    for (const item of requests) {
      await expect(dispatcher.dispatch(item)).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'invalid_argument',
          message: 'Federated Dispatch messages route to their Run home; omit --to and --run.'
        }
      })
    }
    expect(
      db.listFederationRelay({ dispatchId, direction: 'to_home', afterSequence: 0 })
    ).toHaveLength(0)
  })

  it('delivers a send that names its own Run home to that home', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    for (const [id, target] of [
      ['home_to', { to: 'run:run-home' }],
      ['home_run', { run: 'run-home' }]
    ] as const) {
      await expect(
        dispatcher.dispatch(
          request(id, 'orchestration.send', {
            from: 'term_remote_worker',
            ...target,
            subject: 'Progress'
          })
        )
      ).resolves.toMatchObject({ ok: true })
    }
    expect(
      db.listFederationRelay({
        dispatchId: 'ctx_remote_targeting',
        direction: 'to_home',
        afterSequence: 0
      })
    ).toHaveLength(2)
    expect(db.getInbox()).toHaveLength(0)
  })

  it('refuses a Run a remote Dispatch here reports to once the link to it is lost', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    // The agent now runs in a pane its remote Dispatch was never attached to.
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_other:leaf_other')
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    for (const [id, target] of [
      ['lost_to', { to: 'run:run-home' }],
      ['lost_run', { run: 'run-home' }]
    ] as const) {
      await expect(
        dispatcher.dispatch(
          request(id, 'orchestration.send', {
            from: 'term_remote_worker',
            ...target,
            type: 'worker_done',
            subject: 'Done',
            payload: JSON.stringify({ outcome: 'succeeded' })
          })
        )
      ).resolves.toMatchObject({
        ok: false,
        error: {
          code: 'run_home_unreachable',
          message: expect.stringContaining(
            "Run run-home lives on the computer that coordinates Dispatch ctx_remote_targeting, which isn't reachable"
          )
        }
      })
    }
    expect(db.getInbox()).toHaveLength(0)
    expect(
      db.listFederationRelay({
        dispatchId: 'ctx_remote_targeting',
        direction: 'to_home',
        afterSequence: 0
      })
    ).toHaveLength(0)
  })

  it('still delivers to a local Run no remote Dispatch reports to', async () => {
    ;({ db, runtime } = attachedRemoteWorker())
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_other:leaf_other')
    const local = db.createRun({
      objective: 'local run',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab_coordinator:leaf_coordinator'
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    await expect(
      dispatcher.dispatch(
        request('local_to', 'orchestration.send', {
          from: 'term_local_sender',
          to: `run:${local.id}`,
          subject: 'Hello'
        })
      )
    ).resolves.toMatchObject({ ok: true })
    expect(db.getInbox().map((message) => message.to_handle)).toEqual([`run:${local.id}`])
  })
})

/** A worker pane bound to remote Dispatch ctx_remote_targeting, whose Run home is `run-home`. */
function attachedRemoteWorker(): { db: OrchestrationDb; runtime: OrcaRuntimeService } {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  const paneKey = 'tab_worker:leaf_worker'
  const processIncarnation = 'worker_epoch:pty:1'
  const dispatchId = 'ctx_remote_targeting'
  vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(paneKey)
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(processIncarnation)
  db.createRemoteDispatchAttachment({
    runId: 'run-home',
    dispatchId,
    taskId: 'task_remote_targeting',
    homePeerFingerprint: 'home_peer',
    protocolVersion: 1,
    runtimeEpoch: runtime.getRuntimeId(),
    mutationReceipt: {
      callerFingerprint: 'home_peer',
      requestId: 'attach_request',
      method: 'orchestration.federationAttachStart',
      payloadHash: 'attach_payload'
    }
  })
  db.prepareRemoteAttachmentAuthority({
    dispatchId,
    paneKey,
    processIncarnation,
    worktreeId: 'repo::remote-worktree',
    terminalHandle: 'term_remote_worker',
    setupState: 'not_applicable',
    effects: []
  })
  db.markRemoteAttachmentReady(dispatchId)
  return { db, runtime }
}

function request(
  id: string,
  method: 'orchestration.send' | 'orchestration.ask',
  params: Record<string, unknown>
): RpcRequest {
  return {
    id: `rpc_${id}`,
    authToken: 'worker-token',
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: `request_${id}`,
    method,
    params
  }
}
