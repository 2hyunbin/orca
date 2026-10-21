import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeTerminalSleepResult } from '../../../shared/runtime-types'
import type { WorkspaceSleepTarget } from '../../../shared/workspace-sleep'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { WorkspaceLifecycleQueue } from './workspace-lifecycle-queue'
import { sleepWorkspaces, type WorkspaceSleepDeps } from './workspace-sleep-execution'

const SELF = { kind: 'self' } as const
const local = (worktreeId: string): WorkspaceSleepTarget => ({
  worktreeId,
  terminalHost: SELF,
  chatHosts: [SELF]
})
const slept = (ptyIds: string[]): RuntimeWorktreeTerminalSleepResult => ({
  stopped: ptyIds.length,
  stoppedPtyIds: ptyIds,
  livePtyIds: ptyIds,
  postStopVerified: true
})

function deps(overrides: Partial<WorkspaceSleepDeps> = {}) {
  const log: string[] = []
  const all: WorkspaceSleepDeps = {
    notify: (notice) => log.push(`${notice.phase} ${notice.worktreeId}`),
    sleepOwnTerminals: async (worktreeId) => {
      log.push(`terminals ${worktreeId}`)
      return slept([`pty-${worktreeId}`])
    },
    callEnvironment: () => async () => {
      throw new Error('no server')
    },
    stopOwnChats: async (worktreeId) => {
      log.push(`chats ${worktreeId}`)
      return { stoppedSessionIds: [`chat-${worktreeId}`] }
    },
    environmentMarksSleep: async () => true,
    suspendVm: async (worktreeId) => {
      log.push(`vm ${worktreeId}`)
    },
    ...overrides
  }
  return { log, deps: all }
}

const queue = new WorkspaceLifecycleQueue()
const enqueue: Parameters<typeof sleepWorkspaces>[1] = (target, command) =>
  queue.submit(`local|${target.worktreeId}`, command)

describe('sleepWorkspaces', () => {
  it('runs a sleep in order: the window follows, terminals stop, chats stop, then the VM', async () => {
    const { log, deps: d } = deps()
    const outcomes = await sleepWorkspaces(d, enqueue, {
      targets: [local('wt-1')],
      markChatsAsleep: true
    })
    expect(log).toEqual(['started wt-1', 'terminals wt-1', 'chats wt-1', 'vm wt-1', 'ended wt-1'])
    expect(outcomes).toEqual([
      {
        worktreeId: 'wt-1',
        chatFailed: false,
        receipts: [{ executionHostId: 'local', stoppedSessionIds: ['chat-wt-1'] }]
      }
    ])
  })

  it('suspends no VM until every workspace in the batch has stopped its chats', async () => {
    let releaseChats!: () => void
    const held = new Promise<void>((resolve) => (releaseChats = resolve))
    const { log, deps: d } = deps({
      stopOwnChats: async (worktreeId) => {
        if (worktreeId === 'wt-2') {
          await held
        }
        log.push(`chats ${worktreeId}`)
        return { stoppedSessionIds: [] }
      }
    })
    const sleeping = sleepWorkspaces(d, enqueue, { targets: [local('wt-1'), local('wt-2')] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(log).not.toContain('vm wt-1')
    releaseChats()
    await sleeping
    expect(log.indexOf('chats wt-2')).toBeLessThan(log.indexOf('vm wt-1'))
  })

  it('keeps a workspace open when its host cannot prove the stop, and pauses its queue', async () => {
    const notices: unknown[] = []
    const { log, deps: d } = deps({
      notify: (notice) => notices.push(notice),
      sleepOwnTerminals: async () => ({
        stopped: 1,
        stoppedPtyIds: ['pty-a'],
        livePtyIds: ['pty-a', 'pty-b'],
        postStopVerified: false,
        postStopFailure: 'terminal_liveness_unavailable'
      })
    })
    const own = new WorkspaceLifecycleQueue()
    const [outcome] = await sleepWorkspaces(
      d,
      (target, command) => own.submit(target.worktreeId, command),
      { targets: [local('wt-1')] }
    )
    expect(outcome).toEqual(
      expect.objectContaining({ worktreeId: 'wt-1', failure: 'terminal_liveness_unavailable' })
    )
    // The window rolls back only what was not proven stopped.
    expect(notices.at(-1)).toEqual({
      worktreeId: 'wt-1',
      phase: 'ended',
      slept: false,
      stoppedPtyIds: ['pty-a']
    })
    expect(log).not.toContain('vm wt-1')
    expect(own.isPaused('wt-1')).toBe(true)
  })

  it('treats a terminal observed still live as a definite failure, not a pause', async () => {
    const { deps: d } = deps({
      sleepOwnTerminals: async () => ({
        stopped: 0,
        stoppedPtyIds: [],
        livePtyIds: ['pty-a'],
        postStopVerified: false,
        postStopFailure: 'terminal_worktree_sleep_still_live',
        remainingLivePtyIds: ['pty-a']
      })
    })
    const own = new WorkspaceLifecycleQueue()
    const [outcome] = await sleepWorkspaces(
      d,
      (target, command) => own.submit(target.worktreeId, command),
      { targets: [local('wt-1')] }
    )
    expect(outcome?.failure).toBe('terminal_worktree_sleep_still_live')
    expect(own.isPaused('wt-1')).toBe(false)
  })

  it('reports an unconfirmed chat stop, keeps the terminals asleep, and pauses', async () => {
    const { log, deps: d } = deps({
      stopOwnChats: async () => ({
        stoppedSessionIds: [],
        failures: [{ reason: 'stop-unverifiable' }]
      })
    })
    const own = new WorkspaceLifecycleQueue()
    const [outcome] = await sleepWorkspaces(
      d,
      (target, command) => own.submit(target.worktreeId, command),
      { targets: [local('wt-1')] }
    )
    expect(outcome).toEqual(expect.objectContaining({ chatFailed: true }))
    expect(outcome?.failure).toBeUndefined()
    expect(log).toContain('vm wt-1')
    expect(own.isPaused('wt-1')).toBe(true)
  })

  it("sleeps a paired server's copy on that server, with its PTY ids as the window binds them", async () => {
    const calls: [string, unknown][] = []
    const notices: unknown[] = []
    const { deps: d } = deps({
      notify: (notice) => notices.push(notice),
      callEnvironment: () => async (method, params) => {
        calls.push([method, params])
        return method === 'terminal.sleep'
          ? { stopped: 1, stoppedPtyIds: ['pty-1'], livePtyIds: ['pty-1'], postStopVerified: true }
          : { stoppedSessionIds: ['chat-1'] }
      },
      environmentMarksSleep: async () => false
    })
    const env = { kind: 'environment', environmentId: 'env-a' } as const
    const [outcome] = await sleepWorkspaces(d, enqueue, {
      targets: [{ worktreeId: 'wt-r', terminalHost: env, chatHosts: [env] }],
      markChatsAsleep: true
    })
    // A server that predates Sleep's mark would refuse the field, so it is left off.
    expect(calls).toEqual([
      ['terminal.sleep', { worktree: 'id:wt-r' }],
      ['agentSession.sleepWorkspace', { workspaceId: 'wt-r' }]
    ])
    expect(outcome?.receipts).toEqual([
      { executionHostId: 'runtime:env-a', stoppedSessionIds: ['chat-1'] }
    ])
    expect(notices.at(-1)).toEqual({
      worktreeId: 'wt-r',
      phase: 'ended',
      slept: true,
      stoppedPtyIds: [toRemoteRuntimePtyId('pty-1', 'env-a')]
    })
  })

  it("stops an older server's terminals and polls until none is live", async () => {
    const methods: string[] = []
    const { deps: d } = deps({
      callEnvironment: () => async (method) => {
        methods.push(method)
        if (method === 'terminal.sleep') {
          throw Object.assign(new Error('unknown'), { code: 'method_not_found' })
        }
        return method === 'terminal.list'
          ? { terminals: [], totalCount: 0, truncated: false }
          : { stoppedSessionIds: [] }
      }
    })
    const env = { kind: 'environment', environmentId: 'env-old' } as const
    const [outcome] = await sleepWorkspaces(d, enqueue, {
      targets: [{ worktreeId: 'wt-o', terminalHost: env, chatHosts: [] }]
    })
    expect(methods).toEqual(['terminal.sleep', 'terminal.stop', 'terminal.list'])
    expect(outcome?.failure).toBeUndefined()
  })

  it('releases the batch when a delete cancels one workspace’s queued sleep', async () => {
    const own = new WorkspaceLifecycleQueue()
    let releaseHold!: () => void
    const hold = new Promise<void>((resolve) => (releaseHold = resolve))
    void own.submit('wt-2', { kind: 'close', run: () => hold })
    const { log, deps: d } = deps()
    const sleeping = sleepWorkspaces(
      d,
      (target, command) => own.submit(target.worktreeId, command),
      {
        targets: [local('wt-1'), local('wt-2')]
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    void own.submit('wt-2', { kind: 'delete', run: async () => undefined })
    const outcomes = await sleeping
    expect(outcomes[1]).toEqual(expect.objectContaining({ failure: 'workspace_deleted' }))
    expect(log).toContain('vm wt-1')
    releaseHold()
  })

  it('suspends nothing on a host without VM support', async () => {
    const { log, deps: d } = deps({ suspendVm: null })
    await sleepWorkspaces(d, enqueue, { targets: [local('wt-1')] })
    expect(log).toEqual(['started wt-1', 'terminals wt-1', 'chats wt-1', 'ended wt-1'])
  })
})
