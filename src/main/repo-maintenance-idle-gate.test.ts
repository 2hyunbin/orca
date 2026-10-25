import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const isOnBatteryPowerMock = vi.hoisted(() => vi.fn(() => false))
const hasPendingPreparationsMock = vi.hoisted(() => vi.fn(() => false))
const hasRemovalsInFlightMock = vi.hoisted(() => vi.fn(() => false))
const setProbeMock = vi.hoisted(() => vi.fn())
const setBacklogProbeMock = vi.hoisted(() => vi.fn<(probe: (() => boolean) | null) => void>())
const focusedWindowMock = vi.hoisted(() => vi.fn((): object | null => null))
const systemIdleSecondsMock = vi.hoisted(() => vi.fn(() => 0))
const disposeMock = vi.hoisted(() => vi.fn(async () => {}))
const postponeMock = vi.hoisted(() => vi.fn())
const powerListeners = vi.hoisted(() => new Map<string, () => void>())
const appListeners = vi.hoisted(() => new Map<string, () => void>())

vi.mock('electron', () => ({
  app: {
    on: (event: string, listener: () => void) => appListeners.set(event, listener),
    off: (event: string) => appListeners.delete(event)
  },
  BrowserWindow: { getFocusedWindow: focusedWindowMock },
  powerMonitor: {
    isOnBatteryPower: isOnBatteryPowerMock,
    getSystemIdleTime: systemIdleSecondsMock,
    on: (event: string, listener: () => void) => powerListeners.set(event, listener),
    off: (event: string) => powerListeners.delete(event)
  }
}))

vi.mock('./worktree-create-preparation', () => ({
  hasPendingWorktreeCreatePreparations: hasPendingPreparationsMock
}))

vi.mock('./ipc/worktrees/worktree-ipc-context', () => ({
  hasWorktreeRemovalsInFlight: hasRemovalsInFlightMock
}))

vi.mock('./git/local-repo-ref-maintenance', () => ({
  setRepoMaintenanceActivityProbe: setProbeMock,
  setRepoObjectBacklogProbe: setBacklogProbeMock,
  disposeLocalRepoRefMaintenance: disposeMock,
  postponeRepoRefMaintenance: postponeMock
}))

import { installRepoMaintenanceIdleGate } from './repo-maintenance-idle-gate'

function installProbe(
  overrides: Partial<{ isQuitting: () => boolean; getWorkingAgentCount: () => number }> = {}
): { probe: () => boolean; uninstall: () => Promise<void> } {
  const uninstall = installRepoMaintenanceIdleGate({
    isQuitting: () => false,
    getWorkingAgentCount: () => 0,
    ...overrides
  })
  return { probe: setProbeMock.mock.calls.at(-1)?.[0] as () => boolean, uninstall }
}

beforeEach(() => {
  isOnBatteryPowerMock.mockReturnValue(false)
  hasPendingPreparationsMock.mockReturnValue(false)
  hasRemovalsInFlightMock.mockReturnValue(false)
  postponeMock.mockClear()
  powerListeners.clear()
  appListeners.clear()
  setProbeMock.mockClear()
  setBacklogProbeMock.mockClear()
  focusedWindowMock.mockReturnValue(null)
  systemIdleSecondsMock.mockReturnValue(0)
  disposeMock.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('repo maintenance idle gate', () => {
  it('reports idle when nothing is happening', () => {
    expect(installProbe().probe()).toBe(false)
  })

  it('vetoes while an agent is working', () => {
    expect(installProbe({ getWorkingAgentCount: () => 1 }).probe()).toBe(true)
  })

  it('vetoes while a worktree create is prepared or in flight', () => {
    hasPendingPreparationsMock.mockReturnValue(true)

    expect(installProbe().probe()).toBe(true)
  })

  it('vetoes while a worktree removal is deleting refs', () => {
    hasRemovalsInFlightMock.mockReturnValue(true)

    expect(installProbe().probe()).toBe(true)
  })

  it('vetoes on battery power', () => {
    isOnBatteryPowerMock.mockReturnValue(true)

    expect(installProbe().probe()).toBe(true)
  })

  it('vetoes during shutdown', () => {
    expect(installProbe({ isQuitting: () => true }).probe()).toBe(true)
  })

  it('treats an unavailable power API as not-on-battery', () => {
    isOnBatteryPowerMock.mockImplementation(() => {
      throw new Error('unsupported')
    })

    expect(installProbe().probe()).toBe(false)
  })

  it('admits a huge first repack only while the user is away from a plugged-in, agent-free app', () => {
    const backlog = (overrides: Parameters<typeof installProbe>[0] = {}): boolean | undefined => {
      installProbe(overrides)
      return setBacklogProbeMock.mock.calls.at(-1)?.[0]?.()
    }
    expect(backlog()).toBe(true)
    focusedWindowMock.mockReturnValue({})
    expect(backlog()).toBe(false)
    systemIdleSecondsMock.mockReturnValue(5 * 60)
    expect(backlog()).toBe(true)
    isOnBatteryPowerMock.mockReturnValue(true)
    expect(backlog()).toBe(false)
    isOnBatteryPowerMock.mockReturnValue(false)
    expect(backlog({ getWorkingAgentCount: () => 1 })).toBe(false)
  })

  it('pushes the next attempt out when the machine drops onto battery', () => {
    installProbe()

    powerListeners.get('on-battery')?.()

    expect(postponeMock).toHaveBeenCalledTimes(1)
  })

  it('pushes the next attempt out when the user comes back to the window', () => {
    // A window left focused while the user is away fires no new focus event.
    installProbe()

    appListeners.get('browser-window-focus')?.()

    expect(postponeMock).toHaveBeenCalledTimes(1)
  })

  it('cancels armed timers, unsubscribes both sources, and clears the probe when uninstalled', async () => {
    await installProbe().uninstall()

    expect(disposeMock).toHaveBeenCalledTimes(1)
    expect(powerListeners.has('on-battery')).toBe(false)
    expect(appListeners.has('browser-window-focus')).toBe(false)
    expect(setProbeMock).toHaveBeenLastCalledWith(null)
    expect(setBacklogProbeMock).toHaveBeenLastCalledWith(null)
  })
})
