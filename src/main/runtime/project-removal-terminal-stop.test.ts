/**
 * The host owns a project's shells, so removing the project stops them itself: a client only
 * stops the workspaces it has loaded, and an unhydrated or hidden one would keep running.
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'

const HIDDEN_WORKTREE_ID = `${TEST_REPO_ID}::/tmp/hidden-worktree`
const OTHER_WORKTREE_ID = 'repo-2::/tmp/other'

function createRemovableRuntime(): {
  runtime: InstanceType<typeof OrcaRuntimeService>
  stopAndWait: ReturnType<typeof vi.fn>
  removeProjectForHost: ReturnType<typeof vi.fn>
} {
  const removeProjectForHost = vi.fn()
  const stopAndWait = vi.fn(async (ptyId: string) => {
    expect(removeProjectForHost).not.toHaveBeenCalled()
    return ptyId !== 'pty-unverifiable'
  })
  const runtime = new OrcaRuntimeService({ ...store, removeProjectForHost } as never)
  runtime.setPtyController({
    write: () => true,
    kill: vi.fn(() => false),
    stopAndWait,
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  return { runtime, stopAndWait, removeProjectForHost }
}

describe('project removal on the execution host', () => {
  it('stops every terminal of the project, including workspaces no client listed', async () => {
    const { runtime, stopAndWait, removeProjectForHost } = createRemovableRuntime()
    runtime.registerPty('pty-visible', TEST_WORKTREE_ID, null)
    runtime.registerPty('pty-hidden', HIDDEN_WORKTREE_ID, null)
    runtime.registerPty('pty-other-project', OTHER_WORKTREE_ID, null)
    runtime.registerPty('pty-ssh-twin', HIDDEN_WORKTREE_ID, 'ssh-target')

    await expect(runtime.removeProject(TEST_REPO_ID)).resolves.toEqual({ removed: true })

    const stoppedPtyIds = stopAndWait.mock.calls.map(([ptyId]) => ptyId)
    expect(stoppedPtyIds.sort()).toEqual(['pty-hidden', 'pty-visible'])
    expect(removeProjectForHost).toHaveBeenCalledWith(TEST_REPO_ID, 'local')
  })

  it('still removes the project when a stop cannot be verified', async () => {
    const { runtime, stopAndWait, removeProjectForHost } = createRemovableRuntime()
    runtime.registerPty('pty-unverifiable', TEST_WORKTREE_ID, null)

    await expect(runtime.removeProject(TEST_REPO_ID)).resolves.toEqual({ removed: true })

    expect(stopAndWait).toHaveBeenCalledWith('pty-unverifiable', expect.anything())
    expect(removeProjectForHost).toHaveBeenCalledTimes(1)
  })
})
