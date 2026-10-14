// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
const DEFAULT_GLOBAL_SETTINGS = createGlobalSettingsFixture()
import { pluginManagementSessionCallSchema } from '../../../../shared/plugins/plugin-environment-provider-session'
import type { PluginEnvironmentProviderSessionOpen } from '../../../../shared/plugins/plugin-environment-provider-session'
import type { PluginChangeEvent } from '../../../../shared/plugins/plugin-change-event'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { usePluginCatalogHost } from './plugin-catalog-host-context'
import { PluginCatalogHostSection } from './PluginCatalogHostSection'

const state = vi.hoisted(() => ({
  settingsSearchQuery: '',
  runtimeEnvironments: [
    { id: 'a', name: 'Host A', createdAt: 1, pairingRevision: 1, runtimeId: 'runtime-a' },
    { id: 'b', name: 'Host B', createdAt: 2, pairingRevision: 2, runtimeId: 'runtime-b' }
  ],
  runtimeStatusByEnvironmentId: new Map(),
  refreshRuntimeEnvironmentStatus: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(<T,>(select: (source: typeof state) => T) => select(state), {
    getState: () => state
  })
}))
vi.mock('./SettingsSection', () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>
}))
vi.mock('./PluginsSettingsSection', () => ({
  PluginsSettingsSection: ({
    settings,
    updateSettings
  }: {
    settings: GlobalSettings
    updateSettings(updates: Partial<GlobalSettings>): Promise<void>
  }) => {
    const host = usePluginCatalogHost()
    return (
      <section>
        <p>{host?.hostLabel ?? 'Desktop catalog'}</p>
        <p>{settings.uiLanguage}</p>
        <button
          onClick={() => {
            void host?.api
              .install({ kind: 'local-path', path: '/host/plugin' })
              .catch(() => undefined)
          }}
        >
          Install sample
        </button>
        <button
          onClick={() => {
            void updateSettings({ uiLanguage: 'fr' }).catch(() => undefined)
          }}
        >
          Use French
        </button>
      </section>
    )
  }
}))
const open = vi.fn(),
  invoke = vi.fn(),
  close = vi.fn(),
  localUpdate = vi.fn(),
  localList = vi.fn()
const sessions = new Map<string, PluginEnvironmentProviderSessionOpen>()
const retired = new Set<(input: { sessionId: string }) => void>()
const changed = new Set<(input: { sessionId: string; change: PluginChangeEvent }) => void>()
let delayed: Promise<unknown> | undefined
let heldPreferences: Promise<GlobalSettings> | undefined
let language = 'en'
function view(id: string | null = 'a', mounted = true, available = true) {
  return (
    <PluginCatalogHostSection
      hostScope={{
        available,
        target: id ? { kind: 'environment', environmentId: id } : { kind: 'local' }
      }}
      mounted={mounted}
      settings={DEFAULT_GLOBAL_SETTINGS}
      updateSettings={localUpdate}
    />
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  sessions.clear()
  retired.clear()
  changed.clear()
  delayed = undefined
  heldPreferences = undefined
  language = 'en'
  open.mockImplementation(async (input: PluginEnvironmentProviderSessionOpen) => {
    sessions.set(input.sessionId, input)
    return { sessionId: input.sessionId, runtimeId: input.runtimeId }
  })
  close.mockResolvedValue(true)
  localUpdate.mockResolvedValue(undefined)
  invoke.mockImplementation(async (raw: unknown) => {
    const { sessionId, request } = pluginManagementSessionCallSchema.parse(raw)
    const selection = sessions.get(sessionId)
    if (!selection || selection.runtimeId !== request.runtimeId) {
      throw new Error('Wrong host')
    }
    if (request.method === 'state') {
      if (heldPreferences) {
        return heldPreferences
      }
      return {
        ...DEFAULT_GLOBAL_SETTINGS,
        uiLanguage: selection.environmentId === 'b' ? 'es' : language
      }
    }
    if (request.method === 'listLanguagePacks' || request.method === 'listTerminalThemes') {
      return []
    }
    if (request.method === 'updateSettings') {
      if (delayed) {
        return delayed
      }
      language = request.input.uiLanguage ?? language
      return { ...DEFAULT_GLOBAL_SETTINGS, uiLanguage: language }
    }
    if (request.method === 'install') {
      return { ok: true }
    }
    throw new Error('Unexpected method')
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        openEnvironmentProviderSession: open,
        callPluginManagementSession: invoke,
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
        list: localList
      }
    }
  })
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})
it('loads host settings and routes installation and preferences through that reviewed catalog', async () => {
  render(view())
  await screen.findByText('Host A')
  await screen.findByText('en')
  expect(open.mock.calls[0][0]).toMatchObject({
    environmentId: 'a',
    runtimeId: 'runtime-a',
    pairingRevision: 1,
    purpose: 'management'
  })
  await userEvent.click(screen.getByRole('button', { name: 'Install sample' }))
  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      request: {
        runtimeId: 'runtime-a',
        method: 'install',
        input: { kind: 'local-path', path: '/host/plugin' }
      }
    })
  )
  await userEvent.click(screen.getByRole('button', { name: 'Use French' }))
  await screen.findByText('fr')
  expect(localUpdate).not.toHaveBeenCalled()
  expect(localList).not.toHaveBeenCalled()
})
it('retires a host switch and drops a late preference response from the previous review', async () => {
  const held = Promise.withResolvers<unknown>()
  delayed = held.promise
  const rendered = render(view())
  await screen.findByText('Host A')
  await userEvent.click(screen.getByRole('button', { name: 'Use French' }))
  const original = open.mock.calls[0][0]
  rendered.rerender(view('b'))
  await screen.findByText('Host B')
  await screen.findByText('es')
  expect(close).toHaveBeenCalledWith({ sessionId: original.sessionId })
  await act(async () => {
    held.resolve({ ...DEFAULT_GLOBAL_SETTINGS, uiLanguage: 'fr' })
    await held.promise
  })
  expect(screen.queryByText('fr')).toBeNull()
  expect(localUpdate).not.toHaveBeenCalled()
})
it('requires explicit reopening after retirement and ignores changes from another session', async () => {
  render(view())
  await screen.findByText('Host A')
  const original = open.mock.calls[0][0]
  const calls = invoke.mock.calls.length
  await act(async () => {
    for (const listener of changed) {
      listener({ sessionId: 'foreign', change: { contentPacksChanged: true } })
    }
  })
  expect(invoke.mock.calls.length).toBe(calls)
  await act(async () => {
    for (const listener of changed) {
      listener({
        sessionId: original.sessionId,
        change: { contentPacksChanged: false, environmentProviderId: 'company.platform/devpods' }
      })
    }
  })
  expect(invoke.mock.calls.length).toBe(calls)
  await act(async () => {
    for (const listener of retired) {
      listener({ sessionId: original.sessionId })
    }
  })
  expect(screen.queryByRole('button', { name: 'Install sample' })).toBeNull()
  expect(screen.queryByText('Desktop catalog')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Reopen review' }))
  await screen.findByText('Host A')
  expect(open).toHaveBeenCalledTimes(2)
  expect(open.mock.calls[1][0].sessionId).not.toBe(original.sessionId)
})
it('does not open hidden panes or unavailable hosts and uses desktop only when explicitly selected', async () => {
  const rendered = render(view('a', false))
  expect(open).not.toHaveBeenCalled()
  rendered.rerender(view('a', true, false))
  expect(open).not.toHaveBeenCalled()
  rendered.rerender(view(null))
  await screen.findByText('Desktop catalog')
  await userEvent.click(screen.getByRole('button', { name: 'Use French' }))
  expect(localUpdate).toHaveBeenCalledWith({ uiLanguage: 'fr' })
  expect(open).not.toHaveBeenCalled()
})

it('coalesces bursts of host changes while retaining one follow-up preference read', async () => {
  render(view())
  await screen.findByText('Host A')
  const original = open.mock.calls[0][0]
  const held = Promise.withResolvers<GlobalSettings>()
  heldPreferences = held.promise
  const before = invoke.mock.calls.filter(
    ([raw]) => pluginManagementSessionCallSchema.parse(raw).request.method === 'state'
  ).length
  await act(async () => {
    for (let index = 0; index < 20; index++) {
      for (const listener of changed) {
        listener({ sessionId: original.sessionId, change: { contentPacksChanged: true } })
      }
    }
  })
  expect(
    invoke.mock.calls.filter(
      ([raw]) => pluginManagementSessionCallSchema.parse(raw).request.method === 'state'
    )
  ).toHaveLength(before + 1)
  await act(async () => {
    heldPreferences = undefined
    held.resolve(DEFAULT_GLOBAL_SETTINGS)
    await held.promise
  })
  expect(
    invoke.mock.calls.filter(
      ([raw]) => pluginManagementSessionCallSchema.parse(raw).request.method === 'state'
    )
  ).toHaveLength(before + 2)
  expect(screen.getByRole('button', { name: 'Install sample' })).toBeTruthy()
})
