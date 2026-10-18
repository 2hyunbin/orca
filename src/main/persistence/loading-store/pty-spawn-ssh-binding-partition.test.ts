import { expect, it, vi } from 'vitest'
import { admitRuntimeSpawnPane, fixture } from './profile-state-delayed-authority-fixture'
import { commitRuntimePtySpawn } from '../../ipc/pty/runtime/spawn-commit'
import { createRuntimePtySpawnState } from '../../ipc/pty/runtime/spawn-state'
import type { PtyRuntimeControllerDeps } from '../../ipc/pty/runtime/controller-deps'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { persistPtyIpcSpawnCommit } from '../../ipc/pty/ipc/spawn-commit-persist'
import { createPtyIpcSpawnState } from '../../ipc/pty/ipc/spawn-state'
import type { PtySpawnIpcDeps } from '../../ipc/pty/ipc/spawn-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const SSH_HOST_ID = 'ssh:ssh-1'
const pane = {
  worktreeId: 'repo-ssh::/remote/wt',
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
}

function sshSession(ptyId: string | null): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [pane.worktreeId]: [
        {
          id: pane.tabId,
          worktreeId: pane.worktreeId,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1,
          ptyId
        }
      ]
    },
    terminalLayoutsByTabId: {
      [pane.tabId]: {
        root: { type: 'leaf', leafId: pane.leafId },
        activeLeafId: pane.leafId,
        expandedLeafId: null,
        ...(ptyId ? { ptyIdsByLeafId: { [pane.leafId]: ptyId } } : {})
      }
    }
  }
}

function boundPtyId(session: WorkspaceSessionState): string | undefined {
  return session.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
}

// Main keeps its own layout over a window save, so a binding only a save carries would be lost.
it.each([
  { spawn: 'fresh', sessionId: undefined },
  { spawn: 'reattach', sessionId: 'ssh:ssh-1@@remote-pty' }
])('binds a window-spawned SSH pane ($spawn) in its SSH partition', async ({ sessionId }) => {
  const { store } = await fixture()
  store.setWorkspaceSession(sshSession(null), SSH_HOST_ID)
  const local = store.getWorkspaceSession('local')
  const ptyId = 'ssh:ssh-1@@remote-pty'
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the commit's persist step runs; its store is real.
  const deps = { runtime: new OrcaRuntimeService(store), store } as PtySpawnIpcDeps
  const ctx = createPtyIpcSpawnState(deps, {
    ...pane,
    connectionId: 'ssh-1',
    ...(sessionId ? { sessionId } : {}),
    cols: 80,
    rows: 24
  })
  ctx.result = { id: ptyId, incarnationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
  ctx.stablePaneOwner = null
  ctx.validatedLeafId = pane.leafId

  await persistPtyIpcSpawnCommit(ctx)

  expect(boundPtyId(store.getWorkspaceSession(SSH_HOST_ID))).toBe(ptyId)
  expect(store.getWorkspaceSession('local').tabsByWorktree).toEqual(local.tabsByWorktree)
})

it('binds a runtime-started SSH pane in the SSH partition it was admitted to', async () => {
  const { store } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  const ptyId = 'ssh:ssh-1@@runtime-pty'
  const incarnationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  runtime.onPtySpawned(ptyId, incarnationId)
  runtime.beginPtyRegistration(ptyId, incarnationId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only commit runs; its runtime/store are real and preflight-only dependencies are unreachable.
  const deps = {
    runtime,
    store,
    options: {},
    sendPtySpawnedToRenderer: vi.fn()
  } as PtyRuntimeControllerDeps
  const ctx = createRuntimePtySpawnState(deps, {
    ...pane,
    connectionId: 'ssh-1',
    cols: 80,
    rows: 24
  })
  ctx.result = { id: ptyId, incarnationId }
  ctx.stablePaneOwner = null
  await admitRuntimeSpawnPane(store, pane, 'ssh-1')
  ctx.hostSessionBinding = { store, ...pane }
  ctx.metadataLeafId = pane.leafId

  await commitRuntimePtySpawn(ctx)

  expect(boundPtyId(store.getWorkspaceSession(SSH_HOST_ID))).toBe(ptyId)
})
