import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredWorkerIdentities } from '../../../../structured-worker-identity'
import { releaseStructuredWorkerSession } from '../../orchestration-structured-worker-session'
import { ORCHESTRATION_FEDERATION_ATTACH_METHODS } from './federation'

vi.mock('../../structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async (args: { envelope: { sessionId: string } }) => ({
    ok: true,
    value: { sessionId: args.envelope.sessionId, fence: 7 }
  })
}))

const databases: OrchestrationDb[] = []
afterEach(() => {
  releaseStructuredWorkerSession('ctx_remote')
  structuredWorkerIdentities.clear()
  setStructuredAgentSessionHost(null)
  for (const db of databases.splice(0)) {
    db.close()
  }
  vi.restoreAllMocks()
})

function receiver(closeFails = false) {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: placement checks only the repository kind.
  vi.spyOn(runtime, 'showRepo').mockResolvedValue({ id: 'repo', kind: 'git' } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: existing placement reads only the workspace id.
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
    id: 'folder:remote'
  } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: launch preference reads only experimentalNativeChat.
  vi.spyOn(runtime, 'getClientSettings').mockReturnValue({ experimentalNativeChat: true } as never)
  vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({ supported: true })
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the receiver reads the worktree id and setup receipt supplied here.
  vi.spyOn(runtime, 'createManagedWorktree').mockResolvedValue({
    worktree: { id: 'repo::remote' },
    setupReceipt: {
      hookFound: true,
      startupPolicy: 'wait-for-setup',
      state: 'running',
      terminalHandle: 'term_setup'
    }
  } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: launch effects read only the terminal list.
  vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
    terminals: [{ handle: 'term_setup', title: 'setup' }]
  } as never)
  vi.spyOn(runtime, 'waitForSetupTerminalCompletion').mockResolvedValue({ exitCode: 1 })
  let closed = false
  let tabId: string | null = 'worker-tab'
  let savedTab = true
  const close = vi.fn(async () => {
    if (closeFails) {
      throw new Error('provider close unproven')
    }
    closed = true
  })
  const send = vi.fn(async () => ({
    ok: true,
    value: { clientMessageId: 'message', submission: { dispatchState: 'unknown' } }
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this receiver reads only the lease, location, subscription, send, and close methods supplied here.
  setStructuredAgentSessionHost({
    subscribe: () => () => {},
    hasSession: () => !closed,
    setSessionTabVisibility: async (_id: string, visible: boolean) => {
      tabId = visible ? 'worker-tab' : null
    },
    notifySessionTabHidden: () => {
      savedTab = tabId !== null
    },
    send,
    close,
    deps: {
      store: {
        listRecords: () => [],
        getSessionTabId: () => tabId,
        getRecord: () => ({
          location: { executionHostId: 'local', wslDistro: null },
          lease: {
            runtimeFence: 7,
            claimStatus: closed ? 'released' : 'live',
            deathEvidence: closed
              ? { kind: 'exit-observed', detail: 'closed', observedAt: 1 }
              : null
          }
        })
      }
    }
  } as never)
  return { db, runtime, close, send, tabVisible: () => tabId !== null, savedTab: () => savedTab }
}

async function attach(runtime: OrcaRuntimeService, createsWorktree: boolean) {
  const method = ORCHESTRATION_FEDERATION_ATTACH_METHODS[0]!
  return method.handler(
    method.params!.parse({
      runId: 'run_home',
      dispatchId: 'ctx_remote',
      taskId: 'task_remote',
      taskSpec: 'remote work',
      protocolVersion: 3,
      supportsAgentSession: true,
      worktree: createsWorktree ? 'new-top-level' : 'folder:remote',
      ...(createsWorktree ? { name: 'remote', repo: 'repo' } : {}),
      agent: 'claude'
    }),
    {
      runtime,
      orchestrationMutation: {
        callerFingerprint: 'home_peer',
        requestId: 'request_remote',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'payload'
      }
    }
  )
}

describe('structured federation start compensation', () => {
  it.each([false, true])(
    'retains an unproven close and retires a settled close after setup failure (%s)',
    async (closeFails) => {
      const host = receiver(closeFails)
      const result = await attach(host.runtime, true)
      expect(result).toMatchObject({
        state: 'failed',
        failedStage: 'setup_wait',
        mode: { mode: 'structured' }
      })
      expect(result).toHaveProperty('residualResources', [
        expect.objectContaining({ kind: 'worktree' }),
        expect.objectContaining({ kind: 'terminal', id: 'term_setup' }),
        ...(closeFails ? [expect.objectContaining({ kind: 'terminal', role: 'agent' })] : [])
      ])
      expect(
        host.db
          .getRemoteDispatchAttachment('ctx_remote')
          ?.residual_resources.includes('structworker_')
      ).toBe(closeFails)
      expect(host.tabVisible()).toBe(closeFails)
      expect(host.savedTab()).toBe(closeFails)
      expect(host.send).not.toHaveBeenCalled()
      expect(host.close).toHaveBeenCalledOnce()
      expect(structuredWorkerIdentities.list()).toEqual([])
      expect(host.db.getRemoteDispatchAttachment('ctx_remote')?.state).toBe('failed')
      expect(host.db.getWorkerTerminalResourceByOwner('ctx_remote')).toBeDefined()
    }
  )

  it('preserves the saved session when the task acknowledgment is uncertain', async () => {
    const host = receiver()
    await expect(attach(host.runtime, false)).resolves.toMatchObject({
      state: 'outcome_unknown',
      failedStage: 'dispatch_input',
      mode: { mode: 'structured' },
      agentSession: { kind: 'structured' }
    })
    expect(host.send).toHaveBeenCalledOnce()
    expect(host.close).not.toHaveBeenCalled()
    expect(structuredWorkerIdentities.list()).toHaveLength(1)
    expect(host.db.getRemoteDispatchAttachment('ctx_remote')?.state).toBe('start_unknown')
    expect(host.db.getWorkerTerminalResourceByOwner('ctx_remote')).toBeDefined()
  })
})
