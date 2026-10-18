import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { localDesktopSession } from '../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  emptySession,
  FOLDER_KEY,
  GIT_KEY
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { WorkspaceLayoutStream } from './workspace-layout-stream'

const mocks = vi.hoisted(() => ({ layoutOwnerIsMain: true }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))

const GROUP = { id: 'group-mixed', parentGroupId: null, connectionId: null }
// GIT_KEY's repo is local; its group-mate lives on an SSH host, so the folder has no single host.
const REPOS = [
  { id: 'repo-1', path: '/Users/dev/orca', projectGroupId: GROUP.id, connectionId: null },
  { id: 'repo-ssh', path: '/home/dev/api', projectGroupId: GROUP.id, connectionId: 'target-1' }
]
const MIXED_FOLDER = {
  id: 'notes-1',
  projectGroupId: GROUP.id,
  folderPath: '/Users/dev/notes',
  connectionId: null
}

function runtimeWithMixedFolder(
  folder: Record<string, unknown> = MIXED_FOLDER,
  groups: Record<string, unknown>[] = [GROUP]
) {
  const partitions = new Map<ExecutionHostId, WorkspaceSessionState>([
    ['local', localDesktopSession()],
    ['ssh:target-1', emptySession()]
  ])
  const applyLayoutCommand = vi.fn(async () => ({ ok: true, result: {} }))
  const store = {
    getRepos: () => REPOS,
    getRepo: (id: string) => REPOS.find((repo) => repo.id === id),
    getProjectGroups: () => groups,
    getFolderWorkspaces: () => [folder],
    getWorkspaceSessionHostIds: () => [...partitions.keys()],
    getWorkspaceSession: (hostId: ExecutionHostId) => partitions.get(hostId) ?? emptySession(),
    onWorkspaceSessionWritten: () => () => {},
    applyLayoutCommand
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing, the stream and apply read only these store methods.
  return { runtime: new OrcaRuntimeService(store as never), applyLayoutCommand }
}

const RATIOS = {
  type: 'setGroupRatios',
  workspace: FOLDER_KEY,
  groupLayout: { type: 'leaf', groupId: 'group-a' }
} as const

afterEach(() => {
  mocks.layoutOwnerIsMain = true
  vi.restoreAllMocks()
})

describe('a folder whose project group mixes local and SSH repos (layout-owner build)', () => {
  it('keeps the layout stream flowing and publishes the folder from the local partition', () => {
    const { runtime } = runtimeWithMixedFolder()
    const { snapshot } = runtime.subscribeWorkspaceLayouts(() => {})
    expect(snapshot.map((entry) => entry.key)).toEqual([GIT_KEY, FOLDER_KEY])
  })

  it('applies a layout command for it to the local partition', async () => {
    const { runtime, applyLayoutCommand } = runtimeWithMixedFolder()
    const reply = await runtime.applyLayoutCommand(RATIOS)
    expect(reply.ok).toBe(true)
    expect(applyLayoutCommand).toHaveBeenCalledWith(RATIOS, ['local'])
  })

  it("follows the project group's host stamp when the folder has none", async () => {
    const { runtime, applyLayoutCommand } = runtimeWithMixedFolder(MIXED_FOLDER, [
      { ...GROUP, executionHostId: 'ssh:target-1' }
    ])
    await runtime.applyLayoutCommand(RATIOS)
    expect(applyLayoutCommand).toHaveBeenCalledWith(RATIOS, ['ssh:target-1'])
  })

  it('still routes a legacy SSH folder with no stamp to its SSH partition', async () => {
    const { runtime, applyLayoutCommand } = runtimeWithMixedFolder({
      ...MIXED_FOLDER,
      projectGroupId: 'group-ssh',
      folderPath: '/home/dev/api'
    })
    await runtime.applyLayoutCommand(RATIOS)
    expect(applyLayoutCommand).toHaveBeenCalledWith(RATIOS, ['ssh:target-1'])
  })
})

describe('the same folder in a window-owned build', () => {
  it('keeps refusing to route it', () => {
    mocks.layoutOwnerIsMain = false
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime } = runtimeWithMixedFolder()
    // Today's whole-projection failure: no workspace is published.
    expect(runtime.subscribeWorkspaceLayouts(() => {}).snapshot).toEqual([])
  })
})

describe('a workspace the router throws on', () => {
  function streamThrowingOn(key: string) {
    const session = localDesktopSession()
    const store = {
      getWorkspaceSession: () => session,
      // Two partitions hold the workspace, so the router throws twice in one projection.
      getWorkspaceSessionHostIds: (): ExecutionHostId[] => ['local', 'ssh:target-1'],
      onWorkspaceSessionWritten: () => () => {}
    }
    return new WorkspaceLayoutStream({
      store: () => store,
      homeHostId: (candidate) => {
        if (candidate === key) {
          throw new Error('route failed')
        }
        return 'local'
      },
      liveTitle: () => null
    })
  }

  it('is left out, and every other workspace is still published, logged once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const stream = streamThrowingOn(FOLDER_KEY)
    expect(stream.subscribe(() => {}).snapshot.map((entry) => entry.key)).toEqual([GIT_KEY])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('still fails the whole projection in a window-owned build', () => {
    mocks.layoutOwnerIsMain = false
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(streamThrowingOn(FOLDER_KEY).subscribe(() => {}).snapshot).toEqual([])
  })
})
