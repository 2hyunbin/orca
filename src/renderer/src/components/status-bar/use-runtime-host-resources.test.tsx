// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeHostResourceSamples } from './runtime-host-resources'
import { useRuntimeHostResources } from './use-runtime-host-resources'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

it('clears stale remote maintenance on failure and stops the existing poll when closed', async () => {
  vi.useFakeTimers()
  vi.mocked(callRuntimeRpc)
    .mockResolvedValueOnce({
      worktrees: [],
      gitMaintenance: [{ repoPath: '/srv/orca', phase: 'objects' }]
    })
    .mockRejectedValueOnce(new Error('disconnected'))
    .mockResolvedValue({ worktrees: [] })
  const { result, rerender } = renderHook(
    ({ open }) => useRuntimeHostResources(open, ['build'], 2_000),
    { initialProps: { open: true } }
  )
  await act(async () => {})
  expect(
    toRuntimeHostResourceSamples(result.current, () => 'Build host')[0]?.gitMaintenance
  ).toEqual([{ repoPath: '/srv/orca', phase: 'objects' }])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000)
  })
  expect(toRuntimeHostResourceSamples(result.current, () => 'Build host')).toEqual([])
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000)
  })
  expect(toRuntimeHostResourceSamples(result.current, () => 'Build host')).toEqual([
    { hostId: 'runtime:build', hostLabel: 'Build host', worktrees: [] }
  ])
  expect(callRuntimeRpc).toHaveBeenCalledTimes(3)
  rerender({ open: false })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(callRuntimeRpc).toHaveBeenCalledTimes(3)
  expect(result.current).toEqual({})
  expect(vi.getTimerCount()).toBe(0)
})
