// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useManagedWorkspaceOpen } from './use-managed-workspace-open'

const mocks = vi.hoisted(() => ({
  host: { environmentId: 'controller-a' },
  connect: vi.fn(),
  list: vi.fn(),
  state: {
    setRuntimeEnvironments: vi.fn(),
    refreshRuntimeEnvironmentStatus: vi.fn(),
    openModal: vi.fn()
  }
}))
vi.mock('./plugin-environment-host-context', () => ({ usePluginEnvironmentHost: () => mocks.host }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.host.environmentId = 'controller-a'
  mocks.list.mockResolvedValue([])
  mocks.state.refreshRuntimeEnvironmentStatus.mockResolvedValue(true)
  vi.stubGlobal('window', {
    api: { runtimeEnvironments: { openManagedWorkspace: mocks.connect, list: mocks.list } }
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('opens the verified child once after refreshing its available status', async () => {
  const held = Promise.withResolvers<{ environment: { id: string } }>()
  mocks.connect.mockReturnValue(held.promise)
  const busy = vi.fn()
  const view = renderHook(() => useManagedWorkspaceOpen(busy))
  let opening: Promise<void> | undefined
  act(() => {
    opening = view.result.current.open('devbox', { id: 'ssh-1', generation: 3 })
    void view.result.current.open('devbox', { id: 'ssh-1', generation: 3 })
  })
  expect(mocks.connect).toHaveBeenCalledExactlyOnceWith({
    controllerEnvironmentId: 'controller-a',
    sshTargetId: 'ssh-1',
    targetGeneration: 3
  })
  await act(async () => {
    held.resolve({ environment: { id: 'child' } })
    await opening
  })
  expect(mocks.state.refreshRuntimeEnvironmentStatus).toHaveBeenCalledWith('child')
  expect(mocks.state.openModal).toHaveBeenCalledExactlyOnceWith('add-repo', {
    managedWorkspaceEnvironmentId: 'child'
  })
  expect(busy.mock.calls).toEqual([[true], [false]])
})

it('does not open a workspace after the selected controller changes', async () => {
  const held = Promise.withResolvers<{ environment: { id: string } }>()
  mocks.connect.mockReturnValue(held.promise)
  const view = renderHook(() => useManagedWorkspaceOpen())
  let opening: Promise<void> | undefined
  act(() => {
    opening = view.result.current.open('devbox', { id: 'ssh-1', generation: 3 })
  })
  mocks.host.environmentId = 'controller-b'
  view.rerender()
  await act(async () => {
    held.resolve({ environment: { id: 'child' } })
    await opening
  })
  expect(mocks.list).not.toHaveBeenCalled()
  expect(mocks.state.openModal).not.toHaveBeenCalled()
})

it('keeps unavailable children out of the project dialog and shows the reconnect action', async () => {
  mocks.connect.mockResolvedValue({ environment: { id: 'child' } })
  mocks.state.refreshRuntimeEnvironmentStatus.mockResolvedValue(false)
  const view = renderHook(() => useManagedWorkspaceOpen())
  await act(async () => view.result.current.open('devbox', { id: 'ssh-1', generation: 3 }))
  expect(mocks.state.openModal).not.toHaveBeenCalled()
  expect(view.result.current.error).toContain('Reconnect')
})
