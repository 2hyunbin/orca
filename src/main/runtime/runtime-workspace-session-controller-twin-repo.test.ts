import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import { RuntimeWorkspaceSessionController } from './runtime-workspace-session-controller'

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

// Rows in catalog order: the store's getRepo answers with the first one, as main's does.
function routeFor(rows: Record<string, unknown>[]): ExecutionHostId | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller reads only repos, folder workspaces and workspace sessions.
  const store = {
    getRepos: () => rows,
    getRepo: (id: string) => rows.find((row) => row.id === id),
    getFolderWorkspaces: () => [],
    getWorkspaceSessionHostIds: () => [],
    getWorkspaceSession: () => getDefaultWorkspaceSession()
  } as never
  const controller = new RuntimeWorkspaceSessionController({
    getStore: () => store,
    resolveFolderConnectionId: () => null,
    hasRuntimeOwnedPtyCandidate: () => false
  })
  return controller.tryGetHostId(WORKTREE_ID)
}

describe('routing a repo id registered on two hosts, in a layout-owner build', () => {
  it.each<[string, Record<string, unknown>[], ExecutionHostId]>([
    ['local and SSH twins', [SSH_ROW, LOCAL_ROW], 'local'],
    ['local and runtime twins', [RUNTIME_ROW, LOCAL_ROW], 'local'],
    ['SSH and runtime twins', [RUNTIME_ROW, SSH_ROW], 'ssh:box']
  ])('routes %s to the primary the window saves to', (_label, rows, expected) => {
    layoutOwner.isMain = true
    expect(routeFor(rows)).toBe(expected)
  })

  it.each<[string, Record<string, unknown>, ExecutionHostId]>([
    ['local', LOCAL_ROW, 'local'],
    ['SSH', SSH_ROW, 'ssh:box'],
    ['runtime', RUNTIME_ROW, 'runtime:env-1']
  ])('leaves a %s-only repo on its own host', (_label, row, expected) => {
    layoutOwner.isMain = true
    expect(routeFor([row])).toBe(expected)
  })
})

describe('routing twins with the layout-owner switch off', () => {
  it.each<[string, Record<string, unknown>[], ExecutionHostId]>([
    ['local and SSH twins', [SSH_ROW, LOCAL_ROW], 'ssh:box'],
    ['local and runtime twins', [RUNTIME_ROW, LOCAL_ROW], 'runtime:env-1'],
    ['SSH and runtime twins', [RUNTIME_ROW, SSH_ROW], 'runtime:env-1']
  ])('keeps the first catalog row for %s', (_label, rows, expected) => {
    layoutOwner.isMain = false
    expect(routeFor(rows)).toBe(expected)
  })
})
