// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PluginEnvironmentHostSection } from './PluginEnvironmentHostSection'
import { environmentProviderUiFixture } from './plugin-environment-provider-ui-fixture'
import type { PluginEnvironmentProviderSessionOpen } from '../../../../shared/plugins/plugin-environment-provider-session'
import { pluginEnvironmentProviderSessionCallSchema } from '../../../../shared/plugins/plugin-environment-provider-session'
import type { PluginChangeEvent } from '../../../../shared/plugins/plugin-change-event'

const state = vi.hoisted(() => ({
  runtimeEnvironments: [
    {
      id: 'host-a',
      name: 'Company A control host',
      createdAt: 1,
      pairingRevision: 1,
      runtimeId: 'runtime-a'
    },
    {
      id: 'host-b',
      name: 'Company B control host',
      createdAt: 2,
      pairingRevision: 2,
      runtimeId: 'runtime-b'
    }
  ],
  runtimeStatusByEnvironmentId: new Map<string, { status: { runtimeId: string } }>(),
  refreshRuntimeEnvironmentStatus: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(<T,>(select: (source: typeof state) => T) => select(state), {
    getState: () => state
  })
}))

const sessions = new Map<string, PluginEnvironmentProviderSessionOpen>()
const changed = new Set<(input: { sessionId: string; change: PluginChangeEvent }) => void>()
const retired = new Set<(input: { sessionId: string }) => void>()
const open = vi.fn(),
  invoke = vi.fn(),
  close = vi.fn(),
  localList = vi.fn()
let configure: Promise<ReturnType<typeof environmentProviderUiFixture>[]> | undefined
let empty = false
function provider(name = 'Company provider') {
  return {
    ...environmentProviderUiFixture(),
    name,
    configuration: { status: 'unconfigured' as const }
  }
}
function view(environmentId = 'host-a') {
  return (
    <PluginEnvironmentHostSection
      hostScope={{ available: true, target: { kind: 'environment', environmentId } }}
      onBrowsePlugins={vi.fn()}
    />
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  sessions.clear()
  changed.clear()
  retired.clear()
  configure = undefined
  empty = false
  open.mockImplementation(async (input: PluginEnvironmentProviderSessionOpen) => {
    sessions.set(input.sessionId, input)
    return { sessionId: input.sessionId, runtimeId: input.runtimeId }
  })
  close.mockResolvedValue(true)
  localList.mockResolvedValue([provider('Desktop provider')])
  invoke.mockImplementation(async (raw: unknown) => {
    const input = pluginEnvironmentProviderSessionCallSchema.parse(raw)
    const selection = sessions.get(input.sessionId)
    if (!selection) {
      throw new Error('Unknown session')
    }
    const name = selection.environmentId === 'host-a' ? 'A machines' : 'B machines'
    if (input.method === 'list') {
      return empty ? [] : [provider(name)]
    }
    if (input.method === 'listSaved') {
      return []
    }
    if (input.method === 'configure') {
      return configure ?? [provider(name)]
    }
    throw new Error('Unexpected provider method')
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        openEnvironmentProviderSession: open,
        callEnvironmentProviderSession: invoke,
        closeEnvironmentProviderSession: close,
        onEnvironmentProviderSessionRetired: (listener: (input: { sessionId: string }) => void) => {
          retired.add(listener)
          return () => retired.delete(listener)
        },
        onEnvironmentProviderSessionChanged: (
          listener: (input: { sessionId: string; change: PluginChangeEvent }) => void
        ) => {
          changed.add(listener)
          return () => changed.delete(listener)
        },
        listEnvironmentProviders: localList,
        listSavedEnvironmentProviders: async () => [],
        onChanged: () => () => undefined
      }
    }
  })
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})

it('shows the selected host in the actual account dialog and sends its captured source review', async () => {
  render(view())
  await screen.findByText('A machines')
  expect(screen.getByText('Provider commands run on Company A control host.')).toBeTruthy()
  expect(localList).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Set up account' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('A machines · Company A control host')).toBeTruthy()
  await userEvent.type(
    within(dialog).getByRole('textbox', { name: 'Account / tenant ID' }),
    'account-a'
  )
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save account' }))
  const selection = open.mock.calls[0]?.[0]
  expect(invoke).toHaveBeenCalledWith({
    sessionId: selection.sessionId,
    method: 'configure',
    input: { input: { ...provider().review, contextId: 'account-a' } }
  })
})

it('retires a switched host and drops its delayed account result without affecting the new review', async () => {
  const held = Promise.withResolvers<ReturnType<typeof environmentProviderUiFixture>[]>()
  configure = held.promise
  const rendered = render(view())
  await screen.findByText('A machines')
  await userEvent.click(screen.getByRole('button', { name: 'Set up account' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Account / tenant ID' }), 'account-a')
  await userEvent.click(screen.getByRole('button', { name: 'Save account' }))
  const original = open.mock.calls[0]?.[0]
  rendered.rerender(view('host-b'))
  await screen.findByText('B machines')
  expect(close).toHaveBeenCalledWith({ sessionId: original.sessionId })
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => held.resolve([provider('Late A result')]))
  expect(screen.queryByText('Late A result')).toBeNull()
  expect(screen.getByText('B machines')).toBeTruthy()
  expect(localList).not.toHaveBeenCalled()
})

it('refuses a foreign admission response and offers a fresh review without desktop fallback', async () => {
  open.mockImplementationOnce(async (input: PluginEnvironmentProviderSessionOpen) => ({
    sessionId: input.sessionId,
    runtimeId: 'replacement-instance'
  }))
  render(view())
  await screen.findByRole('alert')
  expect(localList).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Reopen review' }))
  await screen.findByText('A machines')
  expect(open).toHaveBeenCalledTimes(2)
  expect(close).toHaveBeenCalledTimes(1)
})

it('refreshes from owned host changes and ignores another session’s event', async () => {
  render(view())
  await screen.findByText('A machines')
  const selection = open.mock.calls[0]?.[0]
  empty = true
  await act(async () => {
    for (const listener of changed) {
      listener({ sessionId: 'another-session', change: { contentPacksChanged: true } })
    }
  })
  expect(screen.getByText('A machines')).toBeTruthy()
  await act(async () => {
    for (const listener of changed) {
      listener({ sessionId: selection.sessionId, change: { contentPacksChanged: true } })
    }
  })
  await screen.findByText('Install and enable an environment provider in Plugins to get started.')
  expect(localList).not.toHaveBeenCalled()
})

it('withdraws the old review on disconnect and only loads desktop providers after an explicit host switch', async () => {
  const rendered = render(view())
  await screen.findByText('A machines')
  const selection = open.mock.calls[0]?.[0]
  await act(async () => {
    for (const listener of retired) {
      listener({ sessionId: selection.sessionId })
    }
  })
  expect(screen.queryByText('A machines')).toBeNull()
  expect(screen.getByRole('button', { name: 'Reopen review' })).toBeTruthy()
  expect(localList).not.toHaveBeenCalled()
  rendered.rerender(
    <PluginEnvironmentHostSection
      hostScope={{ available: true, target: { kind: 'local' } }}
      onBrowsePlugins={vi.fn()}
    />
  )
  await screen.findByText('Desktop provider')
  expect(localList).toHaveBeenCalledTimes(1)
})
