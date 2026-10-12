import { withDurableRuntimeStore } from '../runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, getDefaultWorkspaceSession } from '../orca-runtime-test-mocks.spec'
import type { OrchestrationDb } from '../orchestration/db'
import type { WorkspaceSessionState } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession
} from '../orca-runtime-test-fixtures.spec'
import {
  makeLegacyWorkerRecoveryHarness,
  withLegacyWorkerTab
} from '../orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it("retires the exact worker's pane when it exits during recovery", async () => {
    const liveProcess = {
      id: 'pty-post-reveal',
      incarnationId: '45454545-4545-4545-8545-454545454545',
      terminalHandle: 'term_post_reveal',
      title: 'Post-reveal worker',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      wslDistro: null
    } as const
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([liveProcess])
      .mockResolvedValueOnce([liveProcess])
      .mockResolvedValueOnce([])
    const harness = makeLegacyWorkerRecoveryHarness(() => false, listProcesses)

    await expect(harness.runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: ['dispatch-post-reveal'],
      deferredDispatchIds: []
    })

    expect(listProcesses).toHaveBeenCalledTimes(3)
    expect(harness.getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(
      harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
    ).toBeUndefined()
    expect(
      (
        harness.runtime as unknown as {
          ptysById: Map<string, { connected: boolean; incarnationId?: string }>
        }
      ).ptysById.get(harness.ptyId)
    ).toMatchObject({ connected: false, incarnationId: '45454545-4545-4545-8545-454545454545' })
  })

  it('reconciles a same-id process replacement before headless adoption', async () => {
    const exactProcess = {
      id: 'pty-post-reveal',
      incarnationId: '45454545-4545-4545-8545-454545454545',
      terminalHandle: 'term_post_reveal',
      title: 'Post-reveal worker',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      wslDistro: null
    } as const
    const replacement = {
      ...exactProcess,
      incarnationId: '56565656-5656-4656-8656-565656565656',
      terminalHandle: 'term_replacement'
    }
    const listProcesses = vi
      .fn()
      .mockResolvedValueOnce([exactProcess])
      .mockResolvedValueOnce([replacement])
    const harness = makeLegacyWorkerRecoveryHarness(() => false, listProcesses)

    await expect(harness.runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
      adoptedDispatchIds: [],
      exitedDispatchIds: ['dispatch-post-reveal'],
      deferredDispatchIds: []
    })

    expect(harness.getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(
      harness.getSession().sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]
    ).toBeUndefined()
  })

  // Q4: a failed write has no rollback or retry; the change stays in memory, is logged, and the next
  // ordinary save writes it. A worker whose write failed is re-found by orphan adoption at next launch.
  it('settles an adopted worker even while its layout cannot reach disk (Q4)', async () => {
    const workerPaneKey = `legacy-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '99999999-9999-4999-8999-999999999999'
    const session: WorkspaceSessionState = {
      ...withLegacyWorkerTab(
        { ...getDefaultWorkspaceSession(), tabsByWorktree: { [TEST_WORKTREE_ID]: [] } },
        {
          worktreeId: TEST_WORKTREE_ID,
          tabId: 'legacy-worker',
          leafId: HEADLESS_LEAF_ID,
          ptyId: 'pty-persistence-failure'
        }
      ),
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    }
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const flushPendingOrThrowAsync = vi.fn(() => Promise.reject(new Error('disk unavailable')))
    const runtime = new OrcaRuntimeService(
      withDurableRuntimeStore({ ...runtimeStore, flushPendingOrThrowAsync }),
      undefined,
      { canRecoverPersistentLocalPtys: () => true }
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recovery reads only the legacy recovery rows from the database.
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-persistence-failure',
          task_id: 'task-persistence-failure',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_persistence_failure',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-persistence-failure:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_persistence_failure'
        }
      ]
    } as unknown as OrchestrationDb)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: (ptyId) => ptyId === 'pty-persistence-failure',
      listProcesses: async () => [
        {
          id: 'pty-persistence-failure',
          incarnationId,
          terminalHandle: 'term_persistence_failure',
          title: 'Legacy worker',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sleeping = () =>
      runtime.heldWorkspaceLayout(TEST_WORKTREE_ID)?.leaves?.[HEADLESS_LEAF_ID]?.sleeping
    expect(sleeping()).toBeDefined()

    await expect(runtime.reconcileLegacyWorkerTerminals()).resolves.toMatchObject({
      adoptedDispatchIds: ['dispatch-persistence-failure'],
      deferredDispatchIds: []
    })
    expect(flushPendingOrThrowAsync).toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
    // The change stays in memory for the next ordinary save to write.
    expect(sleeping()).toBeUndefined()
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([
      expect.objectContaining({ id: 'legacy-worker' })
    ])
    error.mockRestore()
  })

  it("drops an exited worker's sleeping record whose pane the layout does not hold", async () => {
    const workerPaneKey = `legacy-worker:${HEADLESS_LEAF_ID}`
    const incarnationId = '98989898-9898-4898-8898-989898989898'
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: {
        [workerPaneKey]: {
          paneKey: workerPaneKey,
          tabId: 'legacy-worker',
          worktreeId: TEST_WORKTREE_ID,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'legacy-codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    })
    const runtime = new OrcaRuntimeService(withDurableRuntimeStore(runtimeStore), undefined, {
      canRecoverPersistentLocalPtys: () => true
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recovery reads only the legacy recovery rows from the database.
    runtime.setOrchestrationDb({
      listLegacyWorkerTerminalRecoveryRows: () => [
        {
          dispatch_id: 'dispatch-unplaced',
          task_id: 'task-unplaced',
          dispatch_status: 'completed',
          contract_version: 0,
          assignee_handle: 'term_unplaced',
          assignee_pane_key: workerPaneKey,
          process_incarnation: `pty-unplaced:${incarnationId}`,
          worker_state: 'ready',
          worktree_id: TEST_WORKTREE_ID,
          agent_terminal_handle: 'term_unplaced'
        }
      ],
      reconcileMissingWorkerTerminal: vi.fn()
    } as unknown as OrchestrationDb)
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      hasPty: () => false,
      listProcesses: async () => []
    })

    const result = await runtime.reconcileLegacyWorkerTerminals()

    expect(result.exitedDispatchIds).toEqual(['dispatch-unplaced'])
    expect(getSession().sleepingAgentSessionsByPaneKey?.[workerPaneKey]).toBeUndefined()
  })
})
