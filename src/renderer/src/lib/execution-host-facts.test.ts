import { describe, expect, it, vi } from 'vitest'
import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import { resolveRepoWorktreeLaunchPlatform } from './execution-host-facts'

vi.mock('./new-workspace', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CLIENT_PLATFORM: 'win32'
}))

type State = Parameters<typeof resolveRepoWorktreeLaunchPlatform>[0]

function linuxServer(): Map<string, RuntimeEnvironmentStatus> {
  return new Map([
    [
      'linux-box',
      {
        checkedAt: 1,
        status: {
          runtimeId: 'rt',
          rendererGraphEpoch: 0,
          graphStatus: 'ready',
          authoritativeWindowId: null,
          liveTabCount: 0,
          liveLeafCount: 0,
          hostPlatform: 'linux'
        }
      }
    ]
  ])
}

function state(): State {
  return {
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    projects: [],
    activeRepoId: null,
    activeWorktreeId: null,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads no other setting.
    settings: {} as State['settings'],
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    runtimeStatusByEnvironmentId: linuxServer()
  }
}

const serverRepo = { path: '/srv/repo', executionHostId: 'runtime:linux-box' }

describe('resolveRepoWorktreeLaunchPlatform from a Windows client', () => {
  it("reads a server project's worktree as the server's OS (#27971)", () => {
    expect(
      resolveRepoWorktreeLaunchPlatform(state(), serverRepo, { id: 'wt', path: '/srv/wt' })
    ).toBe('linux')
  })

  it("lets a worktree's own host outrank its repo's", () => {
    expect(
      resolveRepoWorktreeLaunchPlatform(state(), serverRepo, {
        id: 'wt',
        path: 'C:\\wt',
        hostId: 'local'
      })
    ).toBe('win32')
  })

  it('is undefined when the server has not reported its OS', () => {
    const withheld = { ...state(), runtimeStatusByEnvironmentId: new Map() }
    expect(
      resolveRepoWorktreeLaunchPlatform(withheld, serverRepo, { id: 'wt', path: '/srv/wt' })
    ).toBeUndefined()
  })
})
