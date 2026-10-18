import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { RuntimeWorkspaceSessionController } from './runtime-workspace-session-controller'
import type { CachedWorktreeHost } from './twin-repo-session-host'

const layoutOwner = vi.hoisted(() => ({ isMain: true }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

const WORKTREE_ID = 'repo::/work/orca'
const LOCAL_ROW = { id: 'repo' }
const SSH_ROW = { id: 'repo', connectionId: 'box' }
const RUNTIME_ROW = { id: 'repo', executionHostId: 'runtime:env-1' }
const HOST_OF_ROW = new Map<Record<string, unknown>, ExecutionHostId>([
  [LOCAL_ROW, 'local'],
  [SSH_ROW, 'ssh:box'],
  [RUNTIME_ROW, 'runtime:env-1']
])

function sessionListing(worktreeId: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: 'tab',
          ptyId: null,
          worktreeId,
          title: 'shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  }
}

type Setup = {
  // Rows in catalog order: the store's getRepo answers with the first one, as main's does.
  rows: Record<string, unknown>[]
  savedOn?: ExecutionHostId[]
  listedOn?: ExecutionHostId[]
}

function controllerFor({ rows, savedOn = [], listedOn }: Setup) {
  const sessions = new Map(savedOn.map((hostId) => [hostId, sessionListing(WORKTREE_ID)]))
  const cached: CachedWorktreeHost[] | null = listedOn
    ? listedOn.map((hostId) =>
        hostId.startsWith('runtime:')
          ? { id: WORKTREE_ID, runtimeOwnerEnvironmentId: hostId.slice('runtime:'.length) }
          : { id: WORKTREE_ID, hostId }
      )
    : null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller reads only repos, folder workspaces and workspace sessions.
  const store = {
    getRepos: () => rows,
    getRepo: (id: string) => rows.find((row) => row.id === id),
    getFolderWorkspaces: () => [],
    getWorkspaceSessionHostIds: () => [...sessions.keys()],
    getWorkspaceSession: (hostId: ExecutionHostId) =>
      sessions.get(hostId) ?? getDefaultWorkspaceSession()
  } as never
  const controller = new RuntimeWorkspaceSessionController({
    getStore: () => store,
    resolveFolderConnectionId: () => null,
    hasRuntimeOwnedPtyCandidate: () => false,
    getCachedWorktrees: () => cached
  })
  return { controller, sessions }
}

function routeFor(setup: Setup): ExecutionHostId | null {
  return controllerFor(setup).controller.tryGetHostId(WORKTREE_ID)
}

const PAIRS: [string, Record<string, unknown>, Record<string, unknown>][] = [
  ['local and SSH', LOCAL_ROW, SSH_ROW],
  ['local and runtime', LOCAL_ROW, RUNTIME_ROW],
  ['SSH and runtime', SSH_ROW, RUNTIME_ROW]
]

const SINGLE_HOST_CASES = PAIRS.flatMap(([label, a, b]) => [
  { label, rows: [b, a], holder: HOST_OF_ROW.get(a)! },
  { label, rows: [a, b], holder: HOST_OF_ROW.get(b)! }
])

describe('routing a repo id registered on two hosts, in a layout-owner build', () => {
  it.each<[string, Record<string, unknown>[], ExecutionHostId]>([
    ['local and SSH twins', [SSH_ROW, LOCAL_ROW], 'local'],
    ['local and runtime twins', [RUNTIME_ROW, LOCAL_ROW], 'local'],
    ['SSH and runtime twins', [RUNTIME_ROW, SSH_ROW], 'ssh:box']
  ])('routes a worktree both %s hold to the primary the window saves to', (_l, rows, primary) => {
    layoutOwner.isMain = true
    const hosts = rows.map((row) => HOST_OF_ROW.get(row)!)
    expect(routeFor({ rows })).toBe(primary)
    expect(routeFor({ rows, savedOn: hosts })).toBe(primary)
    expect(routeFor({ rows, listedOn: hosts })).toBe(primary)
  })

  it.each(SINGLE_HOST_CASES)(
    '$label twins: a worktree saved only on $holder routes there',
    ({ rows, holder }) => {
      layoutOwner.isMain = true
      expect(routeFor({ rows, savedOn: [holder] })).toBe(holder)
    }
  )

  it.each(SINGLE_HOST_CASES)(
    '$label twins: a fresh worktree listed only on $holder routes there',
    ({ rows, holder }) => {
      layoutOwner.isMain = true
      expect(routeFor({ rows, listedOn: [holder] })).toBe(holder)
    }
  )

  it.each<[string, Record<string, unknown>, ExecutionHostId]>([
    ['local', LOCAL_ROW, 'local'],
    ['SSH', SSH_ROW, 'ssh:box'],
    ['runtime', RUNTIME_ROW, 'runtime:env-1']
  ])('leaves a %s-only repo on its own host', (_label, row, expected) => {
    layoutOwner.isMain = true
    expect(routeFor({ rows: [row] })).toBe(expected)
  })

  it('hydrates a twin worktree from the partition the router picks, not the last repo row', () => {
    layoutOwner.isMain = true
    const { controller, sessions } = controllerFor({
      rows: [RUNTIME_ROW, LOCAL_ROW],
      savedOn: ['runtime:env-1']
    })
    expect(controller.getHydrationTargets(true).get(WORKTREE_ID)).toBe(
      sessions.get('runtime:env-1')
    )
  })
})

describe('routing twins with the layout-owner switch off', () => {
  it.each<[string, Record<string, unknown>[], ExecutionHostId]>([
    ['local and SSH twins', [SSH_ROW, LOCAL_ROW], 'ssh:box'],
    ['local and runtime twins', [RUNTIME_ROW, LOCAL_ROW], 'runtime:env-1'],
    ['SSH and runtime twins', [RUNTIME_ROW, SSH_ROW], 'runtime:env-1']
  ])('keeps the first catalog row for %s', (_label, rows, expected) => {
    layoutOwner.isMain = false
    expect(routeFor({ rows, listedOn: [HOST_OF_ROW.get(rows[1]!)!] })).toBe(expected)
  })

  it('keeps hydrating from the last repo row', () => {
    layoutOwner.isMain = false
    const { controller } = controllerFor({
      rows: [RUNTIME_ROW, LOCAL_ROW],
      savedOn: ['runtime:env-1']
    })
    expect(controller.getHydrationTargets(true).has(WORKTREE_ID)).toBe(false)
  })
})
