// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PluginEnvironmentProviderSavedHistory } from '../../../../shared/plugins/plugin-environment-provider-saved-history-api'
import { PluginEnvironmentSavedProviderCard } from './PluginEnvironmentSavedProviderCard'

afterEach(cleanup)
const entry = {
  executionHostId: 'local' as const,
  providerId: 'company.platform/pods',
  contextId: 'company/account',
  configuredAt: 1
}
const history: PluginEnvironmentProviderSavedHistory = {
  previousCount: 1,
  archivedAt: null,
  snapshot: {
    version: 1,
    binding: {
      executionHostId: 'local',
      providerId: entry.providerId,
      contextId: entry.contextId,
      sourceDigest: 'a'.repeat(64),
      recipeDigest: 'b'.repeat(64)
    },
    resources: [
      {
        id: 'devbox',
        name: 'Long-lived devbox',
        revision: 'r1',
        lifetime: 'long-lived',
        state: 'running'
      }
    ],
    operations: [
      {
        operationId: '11111111-1111-4111-8111-111111111111',
        action: 'create',
        requestDigest: 'c'.repeat(64),
        startedAt: 1,
        status: 'pending'
      }
    ]
  }
}

function install(read: () => Promise<PluginEnvironmentProviderSavedHistory>) {
  const snapshot = vi.fn(read)
  const recover = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: { savedEnvironmentProviderSnapshot: snapshot, recoverEnvironmentProvider: recover }
    }
  })
  return { snapshot, recover }
}

it('shows recorded machines and unresolved history with no connection, lifecycle or receipt controls', async () => {
  const api = install(async () => history)
  render(<PluginEnvironmentSavedProviderCard entry={entry} />)
  expect(api.snapshot).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Show saved inventory' }))
  expect(await screen.findByText('Long-lived devbox')).toBeTruthy()
  expect(screen.getByText('Unresolved machine change', { exact: false })).toBeTruthy()
  for (const name of [
    'Connect',
    'Sleep',
    'Wake',
    'Archive',
    'Delete',
    'Create environment',
    'Check with provider'
  ]) {
    expect(screen.queryByRole('button', { name })).toBeNull()
  }
  expect(api.snapshot).toHaveBeenCalledExactlyOnceWith({ providerId: entry.providerId, offset: 0 })
  expect(api.recover).not.toHaveBeenCalled()
})

it('serializes clicks and keeps failures visible for a fresh retry', async () => {
  const held = Promise.withResolvers<PluginEnvironmentProviderSavedHistory>()
  const api = install(() => held.promise)
  render(<PluginEnvironmentSavedProviderCard entry={entry} />)
  await userEvent.dblClick(screen.getByRole('button', { name: 'Show saved inventory' }))
  expect(api.snapshot).toHaveBeenCalledOnce()
  await act(async () => held.reject(new Error('Saved journal unavailable')))
  expect(await screen.findByRole('alert')).toBeTruthy()
  api.snapshot.mockResolvedValue(history)
  await userEvent.click(screen.getByRole('button', { name: 'Show saved inventory' }))
  expect(await screen.findByText('Long-lived devbox')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('refuses a response for a different host or selected account', async () => {
  const api = install(async () => ({
    ...history,
    snapshot: {
      ...history.snapshot,
      binding: { ...history.snapshot.binding, executionHostId: 'ssh:other' }
    }
  }))
  render(<PluginEnvironmentSavedProviderCard entry={entry} />)
  await userEvent.click(screen.getByRole('button', { name: 'Show saved inventory' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.queryByText('Long-lived devbox')).toBeNull()
  api.snapshot.mockResolvedValue({
    ...history,
    snapshot: {
      ...history.snapshot,
      binding: { ...history.snapshot.binding, contextId: 'other-account' }
    }
  })
  await userEvent.click(screen.getByRole('button', { name: 'Show saved inventory' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.queryByText('Long-lived devbox')).toBeNull()
})

it('browses previous account generations as readonly history', async () => {
  const api = install(async () => history)
  render(<PluginEnvironmentSavedProviderCard entry={entry} />)
  await userEvent.click(screen.getByRole('button', { name: 'Show saved inventory' }))
  expect(await screen.findByText('Long-lived devbox')).toBeTruthy()
  api.snapshot.mockResolvedValue({
    ...history,
    archivedAt: 10,
    snapshot: {
      ...history.snapshot,
      binding: { ...history.snapshot.binding, contextId: 'previous-account' }
    }
  })
  await userEvent.click(screen.getByRole('button', { name: 'Older configuration' }))
  expect(await screen.findByText('previous-account')).toBeTruthy()
  expect(api.snapshot).toHaveBeenLastCalledWith({ providerId: entry.providerId, offset: 1 })
  expect(screen.getByRole('button', { name: 'Older configuration' }).hasAttribute('disabled')).toBe(
    true
  )
  expect(api.recover).not.toHaveBeenCalled()
})
