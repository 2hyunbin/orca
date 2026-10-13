// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { EnvironmentProviderSshPreview } from '../../../../shared/plugins/plugin-environment-provider-ssh-api'
import { PluginEnvironmentConnectionResources } from './PluginEnvironmentConnectionResources'
import { environmentProviderUiFixture } from './plugin-environment-provider-ui-fixture'

const state = vi.hoisted(() => ({
  setSshTargetsMetadata: vi.fn(),
  sshConnectionStates: new Map<string, never>()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
afterEach(cleanup)
const preview: EnvironmentProviderSshPreview = {
  ticketId: '11111111-1111-4111-8111-111111111111',
  expiresAt: Date.now() + 300000,
  providerId: 'company.platform/pods',
  contextId: 'company/account/region',
  resource: {
    id: 'devbox',
    name: 'Devbox',
    revision: 'r2',
    state: 'running',
    lifetime: 'long-lived',
    connection: {
      type: 'ssh',
      host: 'new.internal',
      port: 2222,
      username: 'developer',
      projectRoot: '/projects'
    }
  },
  endpointUpdate: {
    previousConnection: {
      type: 'ssh',
      host: 'old.internal',
      port: 22,
      username: 'developer',
      projectRoot: '/projects'
    },
    savedIdentityFile: true
  }
}
function fixture(read: () => Promise<EnvironmentProviderSshPreview> = async () => preview) {
  const prepare = vi.fn(read),
    discard = vi.fn(async () => true),
    cancel = vi.fn(async () => true)
  const target = {
    id: 'same-saved-host',
    host: 'new.internal',
    port: 2222,
    username: 'developer',
    label: 'Devbox'
  }
  const save = vi.fn(async () => target),
    connect = vi.fn(async () => ({ status: 'connected' }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        prepareEnvironmentProviderSsh: prepare,
        saveEnvironmentProviderSsh: save,
        discardEnvironmentProviderSshReview: discard,
        cancelEnvironmentProvider: cancel
      },
      ssh: { listTargets: vi.fn(async () => [target]), connect }
    }
  })
  const view = render(
    <PluginEnvironmentConnectionResources
      provider={environmentProviderUiFixture()}
      resources={[preview.resource]}
      actions={[]}
      blocked={false}
      ready
      onAction={vi.fn()}
      onReviewing={vi.fn()}
    />
  )
  return { ...view, prepare, save, discard, cancel, connect, target }
}

it('binds explicit endpoint approval to the private ticket and uses normal SSH connection management', async () => {
  const f = fixture()
  await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Update & connect' }))
  await vi.waitFor(() =>
    expect(f.connect).toHaveBeenCalledExactlyOnceWith({ targetId: f.target.id })
  )
  expect(f.save).toHaveBeenCalledExactlyOnceWith({
    ticketId: preview.ticketId,
    approveEndpointUpdate: true
  })
  expect(state.setSshTargetsMetadata).toHaveBeenCalledWith([f.target])
  expect(f.discard).not.toHaveBeenCalled()
})
it('discards a declined review immediately without saving or connecting', async () => {
  const f = fixture()
  await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
  expect(f.discard).toHaveBeenCalledExactlyOnceWith({ ticketId: preview.ticketId })
  expect(f.save).not.toHaveBeenCalled()
  expect(f.connect).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
  f.unmount()
  expect(f.discard).toHaveBeenCalledOnce()
})
it('keeps successful host saving clear when the subsequent SSH connection fails', async () => {
  const f = fixture()
  f.connect.mockImplementation(async () => {
    throw new Error(
      "Error invoking remote method 'ssh:connect': Error: SSH endpoint rejected connection\ninternal diagnostic"
    )
  })
  await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Update & connect' }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('The SSH host is saved.')
  expect(alert.textContent).toContain('SSH endpoint rejected connection')
  expect(alert.textContent).not.toContain('ssh:connect')
  expect(alert.textContent).not.toContain('internal diagnostic')
  expect(f.save).toHaveBeenCalledOnce()
  expect(f.connect).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
})
it('withdraws an issued review when the provider view leaves the screen', async () => {
  const f = fixture()
  await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await screen.findByRole('dialog')
  f.unmount()
  expect(f.discard).toHaveBeenCalledExactlyOnceWith({ ticketId: preview.ticketId })
  expect(f.connect).not.toHaveBeenCalled()
})
it('discards a late inventory result after unmount instead of leaving an unseen approval ticket', async () => {
  const held = Promise.withResolvers<EnvironmentProviderSshPreview>()
  const f = fixture(() => held.promise)
  await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
  f.unmount()
  expect(f.cancel).toHaveBeenCalledOnce()
  await act(async () => held.resolve(preview))
  expect(f.discard).toHaveBeenCalledExactlyOnceWith({ ticketId: preview.ticketId })
  expect(f.save).not.toHaveBeenCalled()
})
it('omits update approval for an ordinary connection review', async () => {
  const { endpointUpdate: _update, ...ordinary } = preview
  const f = fixture(async () => ordinary)
  await userEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Save & connect' }))
  await vi.waitFor(() => expect(f.connect).toHaveBeenCalledOnce())
  expect(f.save).toHaveBeenCalledExactlyOnceWith({ ticketId: preview.ticketId })
})
