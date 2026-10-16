import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, TEST_WORKTREE_ID, store } from '../orca-runtime-test-fixtures.spec'

function makeHeadlessRuntime(runtimeStore: unknown = store) {
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-shell-pick' })
  const runtime = new OrcaRuntimeService(runtimeStore as never)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, spawn }
}

async function onWindowsHost(run: () => Promise<void>): Promise<void> {
  const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    await run()
  } finally {
    Object.defineProperty(process, 'platform', hostPlatform)
  }
}

describe('OrcaRuntimeService session-tab shell selection', () => {
  it('spawns the picked shell for a headless session terminal instead of typing it', async () => {
    await onWindowsHost(async () => {
      const { runtime, spawn } = makeHeadlessRuntime()

      await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        shellOverride: 'git-bash'
      })

      // The defect this pins: the pick rode as `command`, so the managed host typed
      // `git-bash` into PowerShell and the tab stayed PowerShell.
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({ shellOverride: 'git-bash', command: undefined })
      )
    })
  })

  it('refuses a Windows shell on a POSIX host before any terminal exists', async () => {
    const { runtime, spawn } = makeHeadlessRuntime()

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, { shellOverride: 'cmd.exe' })
    ).rejects.toThrow(/names a Windows shell/)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('refuses a shell pick for a workspace that runs over SSH', async () => {
    await onWindowsHost(async () => {
      const remoteRepo = { ...store.getRepo(TEST_REPO_ID)!, connectionId: 'ssh-1' }
      const { runtime, spawn } = makeHeadlessRuntime({
        ...store,
        getRepos: () => [remoteRepo],
        getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined)
      })

      await expect(
        runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, { shellOverride: 'cmd.exe' })
      ).rejects.toThrow(/over SSH/)
      expect(spawn).not.toHaveBeenCalled()
    })
  })
})
