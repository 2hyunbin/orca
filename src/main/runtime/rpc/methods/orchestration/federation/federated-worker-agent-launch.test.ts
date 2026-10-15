import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { releaseStructuredWorkerSession } from '../../orchestration-structured-worker-session'
import { structuredWorkerIdentities } from '../../../../structured-worker-identity'
import { createStructuredAgentSessionForWorktree } from '../../structured-agent-session-create'

vi.mock('../../structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: vi.fn(
    async (args: { envelope: { sessionId: string } }) => ({
      ok: true,
      value: { sessionId: args.envelope.sessionId, fence: 7 }
    })
  )
}))

import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerSetupReceipt } from '../worker/worker-topology'
import { launchFederatedWorkerAgent } from './federated-worker-agent-launch'
import type { FederationEffect } from './federation-effects'
import { FederationAttachStartParams } from './federation-start-schema'

function fakes(created: { startupTerminal?: { handle: string } } = {}) {
  const stages: string[] = []
  const runtime = {
    createManagedWorktree: vi.fn(async (args: { onWorkspaceCreated?: (id: string) => void }) => {
      args.onWorkspaceCreated?.('repo::remote-wt')
      return {
        worktree: { id: 'repo::remote-wt', repoId: 'repo' },
        setupReceipt: {
          hookFound: true,
          startupPolicy: 'wait-for-setup',
          state: 'running',
          terminalHandle: 'term_setup'
        },
        ...created
      }
    }),
    listTerminals: vi.fn(async () => ({
      terminals: [
        { handle: 'term_setup', title: 'setup', tabId: 'tab_s', leafId: 'leaf_s' },
        { handle: 'term_agent', title: 'claude', tabId: 'tab_a', leafId: 'leaf_a' }
      ]
    })),
    createTerminal: vi.fn(async () => ({ handle: 'term_worker' })),
    // Older coordinators retain terminal launches even when this host prefers chat.
    ensureStructuredAgentSessionHost: async () => {},
    getClientSettings: vi.fn(() => ({ experimentalNativeChat: true })),
    getStructuredAgentSessionCreateSupport: vi.fn(async () => ({ supported: true }))
  }
  const db = {
    recordRemoteAttachmentStage: vi.fn((row: { stage: string }) => {
      stages.push(row.stage)
    })
  }
  return { runtime, db, stages }
}

const PARAMS = FederationAttachStartParams.parse({
  runId: 'run_home',
  dispatchId: 'ctx_remote',
  taskId: 'task_remote',
  taskSpec: 'remote work',
  protocolVersion: 3,
  worktree: 'new-top-level',
  repo: 'repo',
  name: 'remote-wt',
  agent: 'claude'
})

function launch(
  f: ReturnType<typeof fakes>,
  worktree?: { id: string },
  supportsAgentSession = false,
  nativeChatDefault?: boolean
) {
  const effects: FederationEffect[] = []
  const setups: WorkerSetupReceipt[] = []
  const stagesSeen: string[] = []
  const done = launchFederatedWorkerAgent({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch calls only the methods faked here.
    runtime: f.runtime as unknown as OrcaRuntimeService,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch records only attachment stages.
    db: f.db as unknown as OrchestrationDb,
    params: { ...PARAMS, supportsAgentSession, nativeChatDefault },
    agent: 'claude',
    launchPreferences: { model: 'opus' },
    ...(worktree ? { worktree } : {}),
    setupSource: 'orchestration_default',
    effects,
    onSetup: (setup) => setups.push(setup),
    onStage: (stage) => stagesSeen.push(stage)
  })
  return { done, effects, setups, stagesSeen }
}

afterEach(() => {
  releaseStructuredWorkerSession('ctx_remote')
  structuredWorkerIdentities.clear()
  setStructuredAgentSessionHost(null)
})

describe('a federated worker through the launch executor', () => {
  it('creates the new top-level worktree agent-first with the attachment’s own records', async () => {
    const f = fakes({ startupTerminal: { handle: 'term_agent' } })
    const run = launch(f)

    await expect(run.done).resolves.toMatchObject({
      worktree: { id: 'repo::remote-wt', repoId: 'repo' },
      terminalHandle: 'term_agent'
    })
    expect(f.runtime.createManagedWorktree).toHaveBeenCalledWith({
      repoSelector: 'repo',
      name: 'remote-wt',
      baseBranch: undefined,
      displayName: undefined,
      displayNameKind: undefined,
      comment: undefined,
      runHooks: false,
      setupDecision: 'run',
      awaitTerminalProvisioning: true,
      observeSetupCompletion: true,
      createdWithAgent: 'claude',
      startupAgent: 'claude',
      startupLaunchSource: 'orchestration',
      startupLaunchPreferences: { model: 'opus' },
      activate: false,
      lineage: { noParent: true }
    })
    expect(f.stages).toEqual(['worktree_creating'])
    expect(run.stagesSeen).toEqual(['worktree_create'])
    expect(f.runtime.createTerminal).not.toHaveBeenCalled()
    expect(f.runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
    expect(run.effects).toEqual([
      { kind: 'worktree', action: 'created_top_level', id: 'repo::remote-wt' },
      {
        kind: 'terminal',
        role: 'setup',
        action: 'created',
        id: 'term_setup',
        tabId: 'tab_s',
        leafId: 'leaf_s'
      },
      {
        kind: 'terminal',
        role: 'agent',
        action: 'created',
        id: 'term_agent',
        tabId: 'tab_a',
        leafId: 'leaf_a'
      },
      {
        kind: 'setup',
        action: 'run',
        requested: 'run',
        effective: 'run',
        source: 'orchestration_default',
        hookFound: true,
        startupPolicy: 'wait-for-setup',
        state: 'running',
        terminalId: 'term_setup'
      }
    ])
  })

  it('reports setup and a recovery shell when chat creation fails', async () => {
    const f = fakes()
    vi.mocked(createStructuredAgentSessionForWorktree).mockRejectedValueOnce(
      new Error('create failed')
    )
    const run = launch(f, undefined, true, true)
    await expect(run.done).rejects.toThrow('create failed')
    expect(run.setups).toMatchObject([{ state: 'running', source: 'orchestration_default' }])
    expect(f.runtime.createTerminal).toHaveBeenCalledWith('id:repo::remote-wt', {
      surfaceOwner: false
    })
    expect(run.effects).toContainEqual(
      expect.objectContaining({ role: 'recovery_shell', id: 'term_worker' })
    )
  })

  it('opens a background worker-<task> terminal in an existing worktree', async () => {
    const f = fakes()
    const run = launch(f, { id: 'folder:remote' })

    await expect(run.done).resolves.toMatchObject({
      worktree: { id: 'folder:remote' },
      terminalHandle: 'term_worker'
    })
    expect(f.runtime.createTerminal).toHaveBeenCalledWith('id:folder:remote', {
      startupAgent: 'claude',
      launchSource: 'orchestration',
      launchPreferences: { model: 'opus' },
      title: 'worker-task_remote',
      presentation: 'background'
    })
    expect(run.effects).toEqual([
      { kind: 'terminal', role: 'agent', action: 'created', id: 'term_worker' }
    ])
    expect(f.runtime.createManagedWorktree).not.toHaveBeenCalled()
    expect(f.runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
    expect(run.stagesSeen).toEqual(['terminal_create', 'terminal_create'])
  })

  it.each([undefined, { id: 'folder:remote' }])(
    'uses the coordinator chat preference after resolving workspace %j',
    async (worktree) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: worker creation reads only subscribe and the local execution location.
      setStructuredAgentSessionHost({
        subscribe: () => () => {},
        deps: {
          store: { getRecord: () => ({ location: { executionHostId: 'local', wslDistro: null } }) }
        }
      } as never)
      const f = fakes()
      f.runtime.getClientSettings.mockReturnValue({ experimentalNativeChat: false })
      const placed = await launch(f, worktree, true, true).done
      expect(placed).toMatchObject({
        mode: { mode: 'structured', reason: 'user_default' },
        agentSession: { kind: 'structured', handle: placed.terminalHandle },
        structuredSession: { identity: { handle: placed.terminalHandle } }
      })
      expect(f.runtime.createTerminal).not.toHaveBeenCalled()
      expect(f.runtime.getStructuredAgentSessionCreateSupport).toHaveBeenCalledOnce()
      if (!worktree) {
        expect(f.runtime.createManagedWorktree).toHaveBeenCalledWith(
          expect.objectContaining({
            promisedAgentChat: true,
            onWorkspaceCreated: expect.any(Function)
          })
        )
      }
    }
  )

  it('keeps the coordinator terminal default when the receiver prefers chat', async () => {
    const f = fakes()
    await expect(launch(f, { id: 'folder:remote' }, true, false).done).resolves.toMatchObject({
      mode: { mode: 'terminal', preferred: 'terminal', reason: 'user_default' }
    })
    expect(f.runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
  })
})
