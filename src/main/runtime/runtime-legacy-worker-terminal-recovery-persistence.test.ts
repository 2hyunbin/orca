import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { RuntimeLegacyWorkerTerminalRecoveryPersistence } from './runtime-legacy-worker-terminal-recovery-persistence'
import type { LegacyWorkerRecoveryResolution } from './runtime-legacy-worker-terminal-recovery-types'
import { fakeStore, holderFor, SSH_HOST, SSH_KEY } from './runtime-workspace-layouts.test-fixture'

function workerSession(key: string, host: ExecutionHostId = 'local'): WorkspaceSessionState {
  const session = addWorkspace(
    emptySession(),
    key,
    [{ id: 'group-a', tabs: [{ id: 'tab-1', leaves: [[leaf(1), 'pty-1']] }] }],
    host
  )
  session.sleepingAgentSessionsByPaneKey = {
    [`tab-1:${leaf(1)}`]: {
      paneKey: `tab-1:${leaf(1)}`,
      tabId: 'tab-1',
      worktreeId: key,
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'session-1' },
      prompt: '',
      state: 'waiting',
      capturedAt: 1,
      updatedAt: 1
    }
  }
  return session
}

function resolution(
  worktreeId: string,
  kind: 'adopted' | 'exited',
  hostId?: ExecutionHostId
): LegacyWorkerRecoveryResolution {
  return {
    resolution: kind,
    ...(hostId ? { hostId } : {}),
    candidate: {
      dispatchId: 'dispatch-1',
      dispatchStatus: 'dispatched',
      contractVersion: 1,
      taskId: 'task-1',
      worktreeId,
      terminalHandle: 'handle-1',
      paneKey: `tab-1:${leaf(1)}`,
      tabId: 'tab-1',
      leafId: leaf(1),
      processIncarnation: 'pty-1:inc-1',
      ptyId: 'pty-1',
      incarnationId: 'inc-1'
    }
  }
}

function setup(sessions: Partial<Record<ExecutionHostId, WorkspaceSessionState>>) {
  const store = fakeStore(sessions)
  const { holder } = holderFor(store, new Set(['pty-1']))
  const owners = new Map<string, ExecutionHostId>([
    [GIT_KEY, 'local'],
    [SSH_KEY, SSH_HOST]
  ])
  const unused = () => {
    throw new Error('Unexpected persistence dependency')
  }
  const persistence = new RuntimeLegacyWorkerTerminalRecoveryPersistence(
    () => holder,
    unused,
    (worktreeId) => owners.get(worktreeId) ?? null
  )
  return { store, holder, persistence }
}

describe('legacy worker recovery through the layout holder', () => {
  it('drops an adopted worker’s sleeping record and keeps its pane', async () => {
    const { store, persistence } = setup({ local: workerSession(GIT_KEY) })

    const persisted = await persistence.persist([resolution(GIT_KEY, 'adopted')])

    expect(persisted).toEqual(new Set(['dispatch-1']))
    const saved = store.sessions.local!
    expect(saved.sleepingAgentSessionsByPaneKey ?? {}).toEqual({})
    expect(saved.tabsByWorktree[GIT_KEY]).toHaveLength(1)
  })

  it('retires an exited worker’s pane with its record', async () => {
    const { store, persistence } = setup({ local: workerSession(GIT_KEY) })

    await persistence.persist([resolution(GIT_KEY, 'exited')])

    const saved = store.sessions.local!
    expect(saved.sleepingAgentSessionsByPaneKey ?? {}).toEqual({})
    expect(saved.tabsByWorktree[GIT_KEY] ?? []).toHaveLength(0)
  })

  it('waits for the layout to be on disk before reporting the batch', async () => {
    const { holder, persistence } = setup({ local: workerSession(GIT_KEY) })
    const durable = Promise.withResolvers<void>()
    vi.spyOn(holder, 'whenDurable').mockReturnValue(durable.promise)
    let settled = false

    const result = persistence.persist([resolution(GIT_KEY, 'adopted')]).then((ids) => {
      settled = true
      return ids
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    durable.resolve()
    expect(await result).toEqual(new Set(['dispatch-1']))
  })

  it('leaves a worker whose host the holder does not hold for a later pass', async () => {
    const { persistence } = setup({ local: workerSession(GIT_KEY) })

    expect(await persistence.persist([])).toEqual(new Set())
    expect(await persistence.persist([resolution('repo-x::/unknown', 'adopted')])).toEqual(
      new Set()
    )
  })

  it('prefers the host that proved the exit over the workspace’s recorded host', async () => {
    const { store, persistence } = setup({
      local: workerSession(GIT_KEY),
      [SSH_HOST]: workerSession(SSH_KEY, SSH_HOST)
    })
    const localBefore = store.sessions.local

    await persistence.persist([resolution(SSH_KEY, 'exited', SSH_HOST)])

    expect(store.sessions[SSH_HOST]!.tabsByWorktree[SSH_KEY] ?? []).toHaveLength(0)
    expect(store.sessions.local).toBe(localBefore)
  })
})
