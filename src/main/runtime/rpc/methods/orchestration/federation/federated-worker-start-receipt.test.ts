import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_AGENT_SESSION_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { startFederatedWorker } from './federated-worker-start'

describe('federated worker start receipt validation', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close()
    }
  })

  it('marks a malformed ready receipt outcome unknown without persisting resources', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    const run = db.createRun({
      objective: 'federated worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_remote',
      name: 'remote',
      peerFingerprint: 'remote_peer',
      pairingRevision: 73
    })
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_environmentId, method, params) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
            ]
          }
        }
        return {
          dispatchId: (params as { dispatchId: string }).dispatchId,
          state: 'ready',
          worktreeId: 'worktree_remote',
          terminalHandle: 'term_remote'
        }
      })

    const result = (await startFederatedWorker({
      params: {
        task: task.id,
        from: 'term_coord',
        on: 'remote',
        worktree: 'id:worktree_remote',
        terminal: 'term_remote'
      },
      runtime,
      db,
      runId: run.id,
      task,
      orchestrationMutation: {
        callerFingerprint: 'caller',
        requestId: 'remote_start',
        method: 'orchestration.workerStart',
        payloadHash: 'payload'
      }
    })) as { dispatchId: string; state: string; lastError?: string }

    expect(result).toMatchObject({
      state: 'outcome_unknown',
      lastError: 'The worker server returned an invalid ready receipt.'
    })
    expect(db.getFederatedDispatch(result.dispatchId)).toMatchObject({
      remote_runtime_epoch: null,
      remote_worktree_id: null,
      remote_terminal_handle: null
    })
    for (const call of remoteCall.mock.calls) {
      expect(call[5]).toEqual({
        ...(call[1] === 'orchestration.federationAttachStart' ? { contractVerified: true } : {}),
        expectedEnvironmentPairingRevision: 73
      })
    }
  })

  it.each([false, true])('negotiates old and new federation peers (%s)', async (capable) => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    vi.spyOn(runtime, 'ensureOrchestrationFederationRelay').mockImplementation(() => undefined)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mode resolution reads only this chat preference.
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue({ experimentalNativeChat: true } as never)
    const run = db.createRun({
      objective: 'federated worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_remote',
      name: 'remote',
      peerFingerprint: 'remote_peer',
      pairingRevision: 73
    })
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_environmentId, method, params) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
              ...(capable
                ? [
                    ORCHESTRATION_FEDERATION_AGENT_SESSION_RUNTIME_CAPABILITY,
                    STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY
                  ]
                : [])
            ]
          }
        }
        if (typeof params !== 'object' || params === null || !('dispatchId' in params)) {
          throw new Error('missing dispatch')
        }
        return {
          dispatchId: params.dispatchId,
          state: 'ready',
          runtimeEpoch: 'epoch_remote',
          worktreeId: 'worktree_remote',
          terminalHandle: capable ? 'structworker_remote' : 'term_remote',
          ...(capable
            ? {
                agentSession: {
                  kind: 'structured',
                  handle: 'structworker_remote',
                  sessionId: 'session_remote'
                },
                mode: {
                  mode: 'structured',
                  preferred: 'structured',
                  reason: 'user_default',
                  detail: 'Receiver default.'
                }
              }
            : {})
        }
      })

    const result = await startFederatedWorker({
      params: {
        task: task.id,
        from: 'term_coord',
        on: 'remote',
        worktree: 'id:worktree_remote',
        agent: 'claude'
      },
      runtime,
      db,
      runId: run.id,
      task,
      orchestrationMutation: {
        callerFingerprint: 'caller',
        requestId: 'remote_start',
        method: 'orchestration.workerStart',
        payloadHash: 'payload'
      }
    })

    const attachCall = remoteCall.mock.calls.find(
      ([, method]) => method === 'orchestration.federationAttachStart'
    )
    expect(attachCall?.[2]).toEqual(
      expect.objectContaining({
        ...(capable ? { supportsAgentSession: true, nativeChatDefault: true } : {}),
        protocolVersion: 1
      })
    )
    if (!capable) {
      expect(attachCall?.[2]).not.toHaveProperty('supportsAgentSession')
      expect(attachCall?.[2]).not.toHaveProperty('nativeChatDefault')
    }
    expect(result).toMatchObject(
      capable
        ? {
            state: 'ready',
            agentSession: { kind: 'structured', sessionId: 'session_remote' },
            mode: { mode: 'structured' }
          }
        : {
            state: 'ready',
            agentSession: { kind: 'terminal', handle: 'term_remote' },
            mode: { mode: 'terminal', preferred: 'structured', reason: 'remote_execution_host' }
          }
    )
  })
})
