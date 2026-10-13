// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PluginEnvironmentActionDialog } from './PluginEnvironmentActionDialog'
import { environmentProviderUiFixture } from './plugin-environment-provider-ui-fixture'

afterEach(cleanup)
describe('provider lifecycle confirmation preserves exact user intent', () => {
  it('requires declared creation fields and bounds duplicate submissions while a command is running', async () => {
    const provider = environmentProviderUiFixture()
    provider.createFields = [{ id: 'region', label: 'Region', required: true }]
    const held = Promise.withResolvers<void>()
    const onRun = vi.fn(() => held.promise)
    const onStop = vi.fn(async () => true)
    render(
      <PluginEnvironmentActionDialog
        intent={{ provider, action: 'create' }}
        onClose={vi.fn()}
        onRun={onRun}
        onStop={onStop}
      />
    )
    const button = screen.getByRole('button', { name: 'Create environment' })
    expect(button.hasAttribute('disabled')).toBe(true)
    await userEvent.type(screen.getByRole('textbox', { name: 'Region *' }), 'east')
    const form = screen.getByRole('dialog').querySelector('form')
    if (!form) {
      throw new Error('Missing creation form')
    }
    act(() => {
      fireEvent.submit(form)
      fireEvent.submit(form)
    })
    expect(onRun).toHaveBeenCalledTimes(1)
    expect(onRun).toHaveBeenCalledWith({ region: 'east' })
    await userEvent.click(screen.getByRole('button', { name: 'Stop command' }))
    expect(onStop).toHaveBeenCalledTimes(1)
    await act(async () => held.resolve())
  })
  it('keeps the selected account, resource and source visible during a same-key update', () => {
    const provider = environmentProviderUiFixture()
    const intent = {
      provider,
      action: 'delete' as const,
      resource: {
        id: 'pod-one',
        name: 'Selected machine',
        revision: 'r1',
        lifetime: 'long-lived' as const,
        state: 'running' as const
      }
    }
    const onRun = vi.fn(async () => {})
    const props = { onClose: vi.fn(), onRun, onStop: vi.fn(async () => true) }
    const view = render(<PluginEnvironmentActionDialog intent={intent} {...props} />)
    view.rerender(
      <PluginEnvironmentActionDialog
        intent={{
          ...intent,
          provider: {
            ...provider,
            name: 'Replaced provider',
            configuration: { status: 'ready', contextId: 'another-account' }
          },
          resource: { ...intent.resource, id: 'pod-two', name: 'Different machine' }
        }}
        {...props}
      />
    )
    expect(screen.getByRole('dialog').textContent).toContain('company/account/region')
    expect(screen.getByRole('dialog').textContent).toContain('pod-one')
    expect(screen.getByRole('dialog').textContent).not.toContain('another-account')
    expect(screen.getByRole('dialog').textContent).not.toContain('Different machine')
  })
  it('keeps failures visible and treats an unavailable cancellation as uncertain', async () => {
    const held = Promise.withResolvers<void>()
    render(
      <PluginEnvironmentActionDialog
        intent={{ provider: environmentProviderUiFixture(), action: 'create' }}
        onClose={vi.fn()}
        onRun={() => held.promise}
        onStop={vi.fn(async () => false)}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Create environment' }))
    await userEvent.click(screen.getByRole('button', { name: 'Stop command' }))
    expect(screen.getByRole('alert').textContent).toContain('no longer attached')
    await act(async () => held.reject(new Error('Provider outcome unknown')))
    expect(screen.getByRole('alert').textContent).toContain('could not confirm')
    expect(
      screen.getByRole('button', { name: 'Create environment' }).hasAttribute('disabled')
    ).toBe(false)
  })
})
