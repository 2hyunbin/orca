// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PluginEnvironmentConnectionDialog } from './PluginEnvironmentConnectionDialog'
import type { EnvironmentProviderSshPreview } from '../../../../shared/plugins/plugin-environment-provider-ssh-api'
afterEach(cleanup)
const preview: EnvironmentProviderSshPreview = {
  ticketId: '11111111-1111-4111-8111-111111111111',
  expiresAt: Date.now() + 300000,
  providerId: 'company.platform/pods',
  contextId: 'company/account',
  resource: {
    id: 'devbox',
    name: 'Existing devbox',
    revision: 'r1',
    lifetime: 'long-lived',
    state: 'running',
    connection: {
      type: 'ssh',
      host: 'box.internal',
      port: 2222,
      username: 'developer',
      configHost: 'company-devbox',
      projectRoot: '/projects'
    }
  }
}
it('pins the reviewed machine and endpoint, labels credentials, and prevents duplicate save', async () => {
  const held = Promise.withResolvers<void>()
  const save = vi.fn(() => held.promise),
    close = vi.fn()
  const view = render(
    <PluginEnvironmentConnectionDialog preview={preview} onSave={save} onClose={close} />
  )
  expect(screen.getByRole('dialog').textContent).toContain('developer@box.internal:2222')
  expect(screen.getByRole('dialog').textContent).toContain('company-devbox')
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Identity file (optional)' }),
    ' /keys/developer '
  )
  view.rerender(
    <PluginEnvironmentConnectionDialog
      preview={{
        ...preview,
        contextId: 'other-account',
        resource: {
          ...preview.resource,
          revision: 'r2',
          connection: { ...preview.resource.connection!, host: 'changed.internal' }
        }
      }}
      onSave={save}
      onClose={close}
    />
  )
  expect(screen.getByRole('dialog').textContent).toContain('company/account')
  expect(screen.getByRole('dialog').textContent).not.toContain('changed.internal')
  const form = screen.getByRole('dialog').querySelector('form')!
  act(() => {
    fireEvent.submit(form)
    fireEvent.submit(form)
  })
  expect(save).toHaveBeenCalledExactlyOnceWith('/keys/developer')
  expect(screen.getByRole('button', { name: 'Save & connect' }).hasAttribute('disabled')).toBe(true)
  expect(close).not.toHaveBeenCalled()
  await act(async () => held.resolve())
})
it('keeps a failed save visible and offers a quiet way to obtain a fresh review', async () => {
  const close = vi.fn()
  render(
    <PluginEnvironmentConnectionDialog
      preview={preview}
      onSave={async () => {
        throw new Error('source changed')
      }}
      onClose={close}
    />
  )
  await userEvent.click(screen.getByRole('button', { name: 'Save & connect' }))
  expect(screen.getByRole('alert').textContent).toContain('refresh')
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(close).toHaveBeenCalledOnce()
})
