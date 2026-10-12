import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession
} from '../orca-runtime-test-fixtures.spec'

describe('a view start of a tab with a saved shell', () => {
  it('rewrites the shell like the window does, while the CLI --shell still refuses', async () => {
    const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      // A PowerShell tab opened while the project ran on the host; the project now runs in WSL.
      const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-saved-shell' })
      const runtime = new OrcaRuntimeService({
        ...runtimeStore,
        getProjects: () => [
          {
            id: 'project-1',
            displayName: 'repo',
            badgeColor: 'blue',
            sourceRepoIds: [TEST_REPO_ID],
            localWindowsRuntimePreference: { kind: 'wsl' as const, distro: 'Ubuntu' },
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })

      await expect(
        runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { shellOverride: 'powershell.exe' })
      ).rejects.toThrow(/runs its terminals in WSL/)
      expect(spawn).not.toHaveBeenCalled()

      runtime.addCatalogWorkspaces([TEST_WORKTREE_ID])
      const reply = runtime.layoutCommands.apply(
        {
          type: 'createTerminalTab',
          workspace: TEST_WORKTREE_ID,
          creation: { shellOverride: 'powershell.exe' }
        },
        { viewId: 'desktop' }
      )
      expect(reply.ok).toBe(true)
      // The spawn lane rewrites it through the project runtime, as for the window's spawn today.
      await vi.waitFor(() =>
        expect(spawn).toHaveBeenCalledWith(
          expect.objectContaining({ shellOverride: 'powershell.exe', runtimeAdmittedPane: true })
        )
      )
    } finally {
      Object.defineProperty(process, 'platform', hostPlatform)
    }
  })
})
