// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PluginEnvironmentMigrationDialog } from './PluginEnvironmentMigrationDialog'
import { environmentProviderUiFixture } from './plugin-environment-provider-ui-fixture'
import type { PluginEnvironmentProviderMigrationPreview } from '../../../../shared/plugins/plugin-environment-provider-migration-api'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})
function preview(): PluginEnvironmentProviderMigrationPreview {
  const binding = {
    providerId: 'company.platform/pods',
    contextId: 'company/account/region',
    executionHostId: 'local',
    sourceDigest: 'a'.repeat(64),
    recipeDigest: 'b'.repeat(64)
  }
  return {
    providerId: binding.providerId,
    ticketId: randomUUID(),
    expiresAt: Date.now() + 300000,
    previousBinding: binding,
    nextBinding: { ...binding, journalId: randomUUID() },
    previousResources: [],
    currentResources: [
      {
        id: 'box',
        name: 'Confirmed machine',
        state: 'running',
        lifetime: 'long-lived',
        revision: 'r1'
      }
    ],
    unresolvedOperationIds: [randomUUID()]
  }
}
it('pins source review, submits one check, preserves failed stop feedback, and confirms only the host ticket', async () => {
  const provider = environmentProviderUiFixture()
  const held = Promise.withResolvers<PluginEnvironmentProviderMigrationPreview>()
  const prepare = vi.fn((_input: unknown) => held.promise)
  const commitHeld = Promise.withResolvers<never>()
  const commit = vi.fn((_input: unknown) => commitHeld.promise),
    cancel = vi.fn(async () => false)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        prepareEnvironmentProviderMigration: prepare,
        commitEnvironmentProviderMigration: commit,
        cancelEnvironmentProvider: cancel
      }
    }
  })
  const close = vi.fn(),
    configured = vi.fn()
  const view = render(
    <PluginEnvironmentMigrationDialog
      provider={provider}
      onClose={close}
      onConfigured={configured}
    />
  )
  view.rerender(
    <PluginEnvironmentMigrationDialog
      provider={{ ...provider, review: { ...provider.review, reviewRevision: 'other-source' } }}
      onClose={close}
      onConfigured={configured}
    />
  )
  const check = screen.getByRole('button', { name: 'Check account' })
  act(() => {
    fireEvent.click(check)
    fireEvent.click(check)
  })
  expect(prepare).toHaveBeenCalledOnce()
  expect(prepare.mock.calls[0]?.[0]).toMatchObject({
    review: { ...provider.review, contextId: 'company/account/region' }
  })
  await userEvent.click(screen.getByRole('button', { name: 'Stop check' }))
  expect(cancel).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert').textContent).toContain('Could not stop')
  const ticket = preview()
  await act(async () => held.resolve(ticket))
  expect(screen.getByText('Confirmed machine')).toBeTruthy()
  expect(screen.getByText(/Unresolved changes in this account stay blocked/)).toBeTruthy()
  const confirm = screen.getByRole('button', { name: 'Confirm configuration' })
  act(() => {
    fireEvent.click(confirm)
    fireEvent.click(confirm)
  })
  expect(commit).toHaveBeenCalledExactlyOnceWith({ ticketId: ticket.ticketId })
  await act(async () => commitHeld.reject(new Error('source changed')))
  expect(close).not.toHaveBeenCalled()
  expect(configured).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toContain('Previous history remains saved')
})
