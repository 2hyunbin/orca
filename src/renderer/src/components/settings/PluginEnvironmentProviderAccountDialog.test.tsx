// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PluginEnvironmentProviderAccountDialog } from './PluginEnvironmentProviderAccountDialog'
import { environmentProviderUiFixture } from './plugin-environment-provider-ui-fixture'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})
it('saves the displayed provider review once, with a trimmed account and no launch environment', async () => {
  const provider = environmentProviderUiFixture()
  const held = Promise.withResolvers<(typeof provider)[]>()
  const configure = vi.fn(() => held.promise)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { plugins: { configureEnvironmentProvider: configure } }
  })
  const onConfigured = vi.fn(),
    onClose = vi.fn()
  const view = render(
    <PluginEnvironmentProviderAccountDialog
      provider={provider}
      onConfigured={onConfigured}
      onClose={onClose}
    />
  )
  await userEvent.type(
    screen.getByRole('textbox', { name: 'Account / tenant ID' }),
    ' company/account/region '
  )
  view.rerender(
    <PluginEnvironmentProviderAccountDialog
      provider={{
        ...provider,
        review: {
          ...provider.review,
          recipeDigest: 'b'.repeat(64),
          reviewRevision: 'changed-release'
        }
      }}
      onConfigured={onConfigured}
      onClose={onClose}
    />
  )
  const form = screen.getByRole('dialog').querySelector('form')
  if (!form) {
    throw new Error('Missing provider account form')
  }
  act(() => {
    fireEvent.submit(form)
    fireEvent.submit(form)
  })
  expect(configure).toHaveBeenCalledTimes(1)
  expect(configure).toHaveBeenCalledWith({
    ...provider.review,
    contextId: 'company/account/region'
  })
  await act(async () => held.resolve([provider]))
  expect(onConfigured).toHaveBeenCalledWith([provider])
  expect(onClose).toHaveBeenCalledTimes(1)
})
