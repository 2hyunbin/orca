import { beforeEach, describe, expect, it, vi } from 'vitest'

const { setProbe, dispose, creating, removing, pendingRemoval } = vi.hoisted(() => ({
  setProbe: vi.fn<(probe: (() => boolean) | null) => void>(),
  dispose: vi.fn(async () => {}),
  creating: vi.fn(() => false),
  removing: vi.fn(() => false),
  pendingRemoval: vi.fn(() => false)
}))
vi.mock('./git/local-repo-ref-maintenance', () => ({
  setRepoMaintenanceActivityProbe: setProbe,
  disposeLocalRepoRefMaintenance: dispose
}))
vi.mock('./worktree-create-preparation', () => ({
  hasPendingWorktreeCreatePreparations: creating
}))
vi.mock('./ipc/worktrees/worktree-ipc-context', () => ({ hasWorktreeRemovalsInFlight: removing }))
vi.mock('./worktree-removal-table', () => ({ hasPendingWorktreeRemovals: pendingRemoval }))

import { installRepoMaintenanceHostIdleGate } from './repo-maintenance-host-idle-gate'

beforeEach(() => {
  vi.clearAllMocks()
  creating.mockReturnValue(false)
  removing.mockReturnValue(false)
  pendingRemoval.mockReturnValue(false)
})

describe('headless maintenance activity', () => {
  it('uses changing host activity without Electron or a connected client', () => {
    let working = 0
    let requestInFlight = false
    let quitting = false
    const uninstall = installRepoMaintenanceHostIdleGate({
      isQuitting: () => quitting,
      getWorkingAgentCount: () => working,
      isBusy: () => requestInFlight
    })
    const probe = setProbe.mock.calls[0]?.[0]
    expect(probe?.()).toBe(false)
    working = 1
    expect(probe?.()).toBe(true)
    working = 0
    requestInFlight = true
    expect(probe?.()).toBe(true)
    requestInFlight = false
    creating.mockReturnValue(true)
    expect(probe?.()).toBe(true)
    creating.mockReturnValue(false)
    removing.mockReturnValue(true)
    expect(probe?.()).toBe(true)
    removing.mockReturnValue(false)
    pendingRemoval.mockReturnValue(true)
    expect(probe?.()).toBe(true)
    pendingRemoval.mockReturnValue(false)
    quitting = true
    expect(probe?.()).toBe(true)
    return uninstall()
  })

  it('stops admission before clearing the activity owner and waits for lock release', async () => {
    let release: (() => void) | undefined
    dispose.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    const uninstall = installRepoMaintenanceHostIdleGate({
      isQuitting: () => false,
      getWorkingAgentCount: () => 0
    })
    const stopped = uninstall()
    expect(dispose).toHaveBeenCalledOnce()
    expect(setProbe).toHaveBeenLastCalledWith(null)
    expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(setProbe.mock.invocationCallOrder[1])
    release?.()
    await stopped
  })
})
