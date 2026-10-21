import { describe, expect, it } from 'vitest'
import { WorkspaceLifecycleQueue } from './workspace-lifecycle-queue'
import {
  closeOutcome,
  deleteLifecycleKey,
  queueTerminalWorkspaceCommand,
  sleepLostContact,
  sleepOutcome
} from './workspace-lifecycle-commands'

const repos = [
  { id: 'repo-local', connectionId: null, executionHostId: null },
  { id: 'repo-ssh', connectionId: 'box', executionHostId: null }
]

function runtime(queue: WorkspaceLifecycleQueue | null) {
  return {
    workspaceLifecycle: queue,
    listRepos: () => repos,
    showManagedWorktree: async (selector: string) => {
      const id = selector.replace(/^id:/, '')
      return { id, repoId: id.split('::')[0] }
    }
  }
}

describe('workspace lifecycle commands', () => {
  it('runs directly in a build with no queue', async () => {
    let ran = false
    const reply = await queueTerminalWorkspaceCommand(runtime(null), 'id:repo-local::/a', {
      kind: 'sleep',
      run: async () => {
        ran = true
        return 'slept'
      }
    })
    expect([ran, reply]).toEqual([true, 'slept'])
  })

  it('keys a command by the host its repo routes to, the same key a delete uses', async () => {
    const queue = new WorkspaceLifecycleQueue()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const sleeping = queueTerminalWorkspaceCommand(runtime(queue), 'id:repo-ssh::/a', {
      kind: 'sleep',
      run: () => gate
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const sshKey = deleteLifecycleKey('ssh:box', 'repo-ssh::/a', 'id:repo-ssh::/a')
    expect(queue.hints()).toEqual({ [sshKey]: { kind: 'sleep', queuedBehind: 0 } })
    expect(deleteLifecycleKey(undefined, 'repo-local::/a', 'x')).toBe('local|repo-local::/a')
    release()
    await sleeping
  })

  it('reads an unconfirmed sleep or close as unverifiable, and an observed result as settled', () => {
    const sleep = { stopped: 1, stoppedPtyIds: [], livePtyIds: [] }
    expect(
      sleepOutcome({
        ...sleep,
        postStopVerified: false,
        postStopFailure: 'terminal_liveness_unavailable'
      })
    ).toBe('unverifiable')
    // A terminal observed still running is a definite answer.
    expect(
      sleepOutcome({
        ...sleep,
        postStopVerified: false,
        postStopFailure: 'terminal_worktree_sleep_still_live',
        remainingLivePtyIds: ['pty-1']
      })
    ).toBe('settled')
    expect(
      sleepOutcome({ stopped: 1, stoppedPtyIds: [], livePtyIds: [], postStopVerified: true })
    ).toBe('settled')
    expect(sleepLostContact(new Error('terminal_liveness_unavailable'))).toBe(true)
    expect(sleepLostContact(new Error('terminal_worktree_sleep_failed'))).toBe(false)
    const closed = { closed: 1, stopped: 1, retiredSurfaces: true as const }
    expect(closeOutcome({ ...closed, ptyStopVerdict: 'unverifiable' })).toBe('unverifiable')
    // A terminal observed still live is a definite answer, not an unconfirmed one.
    expect(closeOutcome({ ...closed, ptyStopVerdict: 'live' })).toBe('settled')
  })
})
