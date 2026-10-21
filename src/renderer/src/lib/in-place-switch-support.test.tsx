// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  refreshLocalRuntimeCapabilities,
  setLocalRuntimeCapabilitiesForTests
} from '@/runtime/local-runtime-capabilities'
import { useInPlaceSwitchCapability } from './in-place-switch-support'

const { probe } = vi.hoisted(() => ({ probe: vi.fn<() => Promise<boolean>>() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({ supportsInPlaceSwitch: probe }))

function Switch() {
  const supported = useInPlaceSwitchCapability('local', 'codex')
  return <button disabled={supported !== true}>Switch to CLI</button>
}
afterEach(cleanup)

it('keeps the switch disabled while loading and re-reads capability changes without a pane update', async () => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  setLocalRuntimeCapabilitiesForTests(null)
  let answer = (_supported: boolean): void => {}
  probe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve
      })
  )
  render(<Switch />)
  expect(screen.getByRole('button', { name: 'Switch to CLI' }).hasAttribute('disabled')).toBe(true)
  await act(async () => {
    answer(true)
  })
  await waitFor(() => expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false))
  probe.mockResolvedValue(false)
  Object.assign(window, { api: { runtime: { getStatus: async () => ({ capabilities: [] }) } } })
  await act(async () => {
    await refreshLocalRuntimeCapabilities()
  })
  await waitFor(() => expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true))
})
