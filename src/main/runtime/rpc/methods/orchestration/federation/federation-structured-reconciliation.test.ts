import '../../../unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredWorkerIdentities } from '../../../../structured-worker-identity'
import { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationEnvironmentTransport } from '../../../../orchestration/environment-transport'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { createFederationWorkerStartRequest as startRequest } from './federation-request.test-support'
import { configureFederationWorkerRuntime } from './federation-runtime.test-support'
import { showFederatedWorker } from './federated-worker-show'
import { releaseStructuredWorkerSession } from '../../orchestration-structured-worker-session'

const creates = vi.hoisted(() => vi.fn(async (sessionId: string) => ({
  ok: true,
  value: { sessionId, fence: 7 }
})))
vi.mock('../../structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async (args: { envelope: { sessionId: string } }) =>
    creates(args.envelope.sessionId)
}))
vi.mock('../../orchestration-structured-worker-session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendStructuredWorkerPreamble: async () => 'accepted'
}))

const databases: OrchestrationDb[] = []
const runtimes: OrcaRuntimeService[] = []
let launchedDispatchId: string | undefined
afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.stopOrchestrationFederationRelay()
  }
  if (launchedDispatchId) {
    releaseStructuredWorkerSession(launchedDispatchId)
  }
  setStructuredAgentSessionHost(null)
  structuredWorkerIdentities.clear()
  for (const db of databases.splice(0)) {
    db.close()
  }
  vi.restoreAllMocks()
})

it('reconciles an accepted structured worker after losing its launch reply without another create', async () => {
  const workerDb = new OrchestrationDb(':memory:')
  const homeDb = new OrchestrationDb(':memory:')
  databases.push(workerDb, homeDb)
  const worker = new OrcaRuntimeService()
  worker.setOrchestrationDb(workerDb)
  configureFederationWorkerRuntime(worker)
  const record = {
    location: { executionHostId: 'local', wslDistro: null },
    lease: { claimStatus: 'live', runtimeFence: 7, deathEvidence: null }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worker identity and observation read only record, subscribe, and hasSession here.
  setStructuredAgentSessionHost({
    deps: { store: { getRecord: () => record, listRecords: () => [] } },
    subscribe: async () => () => {},
    hasSession: () => true
  } as never)
  vi.spyOn(worker, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
  vi.spyOn(worker, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({ supported: true })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mode resolution reads only this chat preference.
  vi.spyOn(worker, 'getClientSettings').mockReturnValue({ experimentalNativeChat: false } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: launch reads only the workspace id and an absent setup receipt.
  vi.mocked(worker.createManagedWorktree).mockResolvedValue({
    worktree: { id: 'repo::windows-worktree', repoId: 'repo' }
  } as never)
  const receiver = new RpcDispatcher({ runtime: worker, methods: ORCHESTRATION_METHODS })
  let loseReply = true
  const transport: OrchestrationEnvironmentTransport = {
    resolve: () => ({
      environmentId: 'remote', name: 'remote', peerFingerprint: 'remote_peer'
    }),
    call: async (_selector, method, params, _timeout, envelope) => {
      if (method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: worker.getStatus(),
          _meta: { runtimeId: worker.getRuntimeId() }
        }
      }
      const response = await receiver.dispatch({
        id: method, authToken: 'home-peer', method, params,
        orchestrationContractVersion: envelope?.orchestrationContractVersion,
        orchestrationRequestId: envelope?.orchestrationRequestId
      })
      if (method === 'orchestration.federationAttachStart' && loseReply) {
        loseReply = false
        throw new Error('connection lost after accepted start')
      }
      return response
    }
  }
  const home = new OrcaRuntimeService(null, undefined, { orchestrationEnvironmentTransport: transport })
  home.setOrchestrationDb(homeDb)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mode resolution reads only this chat preference.
  vi.spyOn(home, 'getClientSettings').mockReturnValue({ experimentalNativeChat: true } as never)
  runtimes.push(home, worker)
  vi.spyOn(home, 'getTerminalPaneKey').mockReturnValue('tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  const sender = new RpcDispatcher({ runtime: home, methods: ORCHESTRATION_METHODS })
  const run = homeDb.createRun({
    objective: 'remote worker', coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const task = homeDb.createTask({ spec: 'remote work', runId: run.id })
  const request = startRequest(task.id, { agent: 'claude' })
  expect(await sender.dispatch(request)).toMatchObject({ ok: true, result: { state: 'outcome_unknown' } })
  home.stopOrchestrationFederationRelay()
  const dispatch = homeDb.getDispatchContext(task.id)!
  launchedDispatchId = dispatch.id
  expect(workerDb.getRemoteDispatchAttachment(dispatch.id)).toMatchObject({
    state: 'ready', terminal_handle: expect.stringMatching(/^structworker_/)
  })
  await sender.dispatch(request)
  const shown = await showFederatedWorker({
    runtime: home, db: homeDb, dispatchId: dispatch.id, dispatch,
    federated: homeDb.getFederatedDispatch(dispatch.id)!
  })
  expect(shown.worker).toMatchObject({ state: 'ready' })
  expect(homeDb.getFederatedDispatch(dispatch.id)?.remote_terminal_handle).toMatch(/^structworker_/)
  expect(creates).toHaveBeenCalledTimes(1)
  expect(worker.createManagedWorktree).toHaveBeenCalledTimes(1)
})
