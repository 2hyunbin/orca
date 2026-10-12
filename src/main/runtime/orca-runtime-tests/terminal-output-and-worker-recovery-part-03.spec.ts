import { describe, expect, it, vi } from 'vitest'
import { TEST_WORKTREE_ID, TEST_WORKTREE_PATH } from '../orca-runtime-test-fixtures.spec'
import { makeLegacyWorkerRecoveryHarness } from '../orca-runtime-test-scenario-builders.spec'

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
})
