// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TerminalLimitSetting } from './TerminalLimitSetting'
import { readTerminalLimit, saveTerminalLimit } from './terminal-limit-transport'
import type { SettingsHostScope } from './settings-host-scope'
import type { TerminalLimitStatus } from '../../../../shared/terminal-limit-policy'
import { advanceRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status-connection-generation'

vi.mock('./terminal-limit-transport', () => ({
  readTerminalLimit: vi.fn(),
  saveTerminalLimit: vi.fn()
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace('{{value}}', String(values?.value))
}))
vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({ runtimeEnvironments: [] })
}))
vi.mock('@/store/host-catalog-fencing', () => ({
  captureHostIdentityFence: () => ({}),
  isHostIdentityFenceCurrent: () => true
}))
vi.mock('./SearchableSetting', () => ({
  SearchableSetting: ({ children }: { children: React.ReactNode }) => children
}))

const local: SettingsHostScope = { target: { kind: 'local' }, available: true }
const base: TerminalLimitStatus = {
  maxTerminals: 256,
  systemPtyLimit: 511,
  source: 'default',
  editable: true,
  daemonNonce: 'daemon-a'
}
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(readTerminalLimit).mockReset().mockResolvedValue(base)
  vi.mocked(saveTerminalLimit)
    .mockReset()
    .mockImplementation(async (_route, update) => ({
      ...base,
      maxTerminals: update.maxTerminals,
      source: 'saved'
    }))
})
afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})
async function render(scope = local): Promise<void> {
  await act(async () => root.render(<TerminalLimitSetting scope={scope} />))
}
function input(): HTMLInputElement {
  const found = container.querySelector('input')
  if (!found) {
    throw new Error('No terminal limit input')
  }
  return found
}
async function type(value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function enter(): Promise<void> {
  await act(async () =>
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  )
}

it('clamps in the input, confirms Enter and blur saves once, and omits the caption and reset', async () => {
  await render()
  expect(input().value).toBe('256')
  expect(input().max).toBe('511')
  expect(container.textContent).toContain('System PTY limit: 511')
  expect(container.textContent).not.toMatch(/Reset|Default:|1–511/)
  await type('9999')
  expect(input().value).toBe('511')
  await enter()
  await act(async () => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(saveTerminalLimit).toHaveBeenCalledTimes(1)
  expect(saveTerminalLimit).toHaveBeenLastCalledWith(
    { target: { kind: 'local' }, at: 'local' },
    { maxTerminals: 511, daemonNonce: 'daemon-a' },
    expect.any(AbortSignal)
  )
  await type('384')
  await act(async () => input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
  expect(input().value).toBe('384')
})

it('discards a late answer and draft when switching execution hosts', async () => {
  let complete: ((value: TerminalLimitStatus) => void) | undefined
  vi.mocked(readTerminalLimit).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  await render()
  expect(input().disabled).toBe(true)
  expect(input().value).toBe('')
  vi.mocked(readTerminalLimit).mockResolvedValue({
    ...base,
    maxTerminals: 128,
    systemPtyLimit: 256,
    daemonNonce: 'daemon-b'
  })
  await render({ target: { kind: 'environment', environmentId: 'server' }, available: true })
  await act(async () => complete?.(base))
  expect(input().value).toBe('128')
  expect(input().max).toBe('256')
  advanceRuntimeEnvironmentConnectionGeneration('server')
  vi.mocked(readTerminalLimit).mockResolvedValue({ ...base, maxTerminals: 64 })
  await render({ target: { kind: 'environment', environmentId: 'server' }, available: true })
  expect(input().value).toBe('64')
})

it('retains a failed draft and ignores its late refresh after a successful retry', async () => {
  await render()
  let completeRefresh: ((value: TerminalLimitStatus) => void) | undefined
  vi.mocked(readTerminalLimit).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeRefresh = resolve
      })
  )
  vi.mocked(saveTerminalLimit).mockRejectedValueOnce(new Error('disk unavailable'))
  await type('384')
  await enter()
  expect(input().value).toBe('384')
  expect(container.textContent).toContain('Couldn’t confirm')
  expect(container.textContent).not.toContain('saved')
  await type('400')
  await enter()
  await act(async () => completeRefresh?.(base))
  expect(input().value).toBe('400')
  expect(container.textContent).not.toContain('Couldn’t confirm')
})

it('keeps confirmed environment values above the bound and leaves old daemons uneditable', async () => {
  vi.mocked(readTerminalLimit).mockResolvedValue({
    ...base,
    maxTerminals: 600,
    source: 'environment',
    editable: false
  })
  await render()
  expect(input().value).toBe('600')
  expect(input().disabled).toBe(true)
  expect(container.textContent).toContain('environment')
  vi.mocked(readTerminalLimit).mockResolvedValue(null)
  await render({ target: { kind: 'environment', environmentId: 'old' }, available: true })
  expect(input().value).toBe('')
  expect(input().disabled).toBe(true)
  expect(container.textContent).toContain('does not support')
})
