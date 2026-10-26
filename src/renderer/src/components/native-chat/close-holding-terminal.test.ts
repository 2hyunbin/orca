import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TerminalPaneCloseCallbacks } from '@/constants/terminal'
const mocks = vi.hoisted(() => ({
  state: { tabsByWorktree: {}, terminalLayoutsByTabId: {}, terminalPtyIncarnationsByPaneKey: {} },
  close: vi.fn(),
  exit: vi.fn(),
  reveal: vi.fn(() => true)
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/reveal-terminal-pane', () => ({ revealTerminalPane: mocks.reveal }))
vi.mock('../terminal-pane/request-active-terminal-pane-close', () => ({
  requestActiveTerminalPaneClose: mocks.close
}))
vi.mock('../terminal-pane/pty-dispatcher', () => ({ subscribeToPtyExit: mocks.exit }))
import {
  closeHoldingTerminalThenContinue,
  HOLDING_TERMINAL_EXIT_TIMEOUT_MS
} from './close-holding-terminal'
const target = {
  executionHostId: 'local' as const,
  worktreeId: 'w',
  tabId: 't',
  leafId: 'l',
  title: 'Build'
}
let callbacks: TerminalPaneCloseCallbacks
let exit: (code: number, context: { incarnationId?: string }) => void
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => {
    run()
    return 1
  })
  mocks.state = {
    tabsByWorktree: { w: [{ id: 't', createdAt: 1 }] },
    terminalLayoutsByTabId: {
      t: { root: { type: 'leaf', leafId: 'l' }, ptyIdsByLeafId: { l: 'pty' } }
    },
    terminalPtyIncarnationsByPaneKey: { 't:l': 'life' }
  }
  mocks.close.mockReset().mockImplementation((_tab, options) => {
    callbacks = options
    return true
  })
  mocks.exit.mockReset().mockImplementation((_pty, listener) => {
    exit = listener
    return vi.fn()
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('subscribes before closing the exact leaf, and waits past local removal for its own exit', async () => {
  const send = vi.fn()
  const result = closeHoldingTerminalThenContinue(target, send)
  expect(mocks.exit.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.close.mock.invocationCallOrder[0]
  )
  expect(callbacks).toMatchObject({ leafId: 'l' })
  mocks.state.tabsByWorktree = {}
  callbacks.onClosed?.()
  exit(0, { incarnationId: 'replacement' })
  expect(send).not.toHaveBeenCalled()
  exit(0, { incarnationId: 'life' })
  expect(await result).toBe(true)
  callbacks.onClosed?.()
  await vi.runAllTimersAsync()
  expect(send).toHaveBeenCalledOnce()
})
it.each(['cancel', 'undelivered', 'replaced'] as const)(
  'does not continue after %s',
  async (kind) => {
    if (kind === 'undelivered') {
      mocks.close.mockReturnValue(false)
    }
    const send = vi.fn()
    const result = closeHoldingTerminalThenContinue(target, send)
    if (kind === 'replaced') {
      mocks.state.terminalPtyIncarnationsByPaneKey = { 't:l': 'new' }
      expect(callbacks.isCurrent?.()).toBe(false)
    }
    if (kind !== 'undelivered') {
      callbacks.onCancel?.()
    }
    expect(await result).toBe(false)
    await vi.runAllTimersAsync()
    expect(send).not.toHaveBeenCalled()
  }
)
it('handles an exit during close and bounds missing exit evidence only after consent', async () => {
  const send = vi.fn()
  const result = closeHoldingTerminalThenContinue(target, send)
  await vi.advanceTimersByTimeAsync(HOLDING_TERMINAL_EXIT_TIMEOUT_MS * 2)
  expect(send).not.toHaveBeenCalled()
  exit(0, { incarnationId: 'life' })
  callbacks.onClosed?.()
  await result
  expect(send).toHaveBeenCalledOnce()
  send.mockClear()
  const timed = closeHoldingTerminalThenContinue(target, send)
  callbacks.onClosed?.()
  await vi.advanceTimersByTimeAsync(HOLDING_TERMINAL_EXIT_TIMEOUT_MS)
  expect(await timed).toBe(true)
  exit(0, { incarnationId: 'life' })
  expect(send).toHaveBeenCalledOnce()
})
it.each([true, false])('paired continuation follows the host close outcome %s', async (success) => {
  const send = vi.fn()
  const result = closeHoldingTerminalThenContinue(
    { ...target, executionHostId: 'runtime:host' },
    send
  )
  callbacks.onClosed?.()
  await vi.advanceTimersByTimeAsync(HOLDING_TERMINAL_EXIT_TIMEOUT_MS * 2)
  expect(send).not.toHaveBeenCalled()
  callbacks.onHostClosed?.(success)
  expect(await result).toBe(success)
  expect(send).toHaveBeenCalledTimes(success ? 1 : 0)
  expect(mocks.exit).not.toHaveBeenCalled()
})

it('does not authorize a replacement pairing while the confirmation is open', async () => {
  replaceRuntimeEnvironmentRevisions([{ id: 'host', createdAt: 1 }])
  const send = vi.fn()
  const result = closeHoldingTerminalThenContinue(
    { ...target, executionHostId: 'runtime:host' },
    send
  )
  replaceRuntimeEnvironmentRevisions([{ id: 'host', createdAt: 2 }])
  expect(callbacks.isCurrent?.()).toBe(false)
  callbacks.onCancel?.()
  expect(await result).toBe(false)
  expect(send).not.toHaveBeenCalled()
})
