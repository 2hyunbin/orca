// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PluginEnvironmentRecoveryDialog } from './PluginEnvironmentRecoveryDialog'
import { environmentProviderUiFixture } from './plugin-environment-provider-ui-fixture'
import type {
  PluginEnvironmentProviderRecoveryResult,
  PluginEnvironmentProviderRecoverRequest
} from '../../../../shared/plugins/plugin-environment-provider-recovery-api'
import type { EnvironmentRecipeJournalOperation } from '../../../../shared/plugins/plugin-environment-recipe-journal'
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})
const operation: EnvironmentRecipeJournalOperation = {
  operationId: randomUUID(),
  action: 'create',
  requestDigest: 'a'.repeat(64),
  startedAt: 1,
  status: 'unverifiable',
  reason: 'cancelled',
  resultDigest: 'b'.repeat(64),
  finishedAt: 2
}
it('pins the old operation and account, submits one new query, and binds stop to that query', async () => {
  const provider = environmentProviderUiFixture()
  const held = Promise.withResolvers<PluginEnvironmentProviderRecoveryResult>()
  const recover = vi.fn((_input: PluginEnvironmentProviderRecoverRequest) => held.promise),
    cancel = vi.fn(async () => false)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { plugins: { recoverEnvironmentProvider: recover, cancelEnvironmentProvider: cancel } }
  })
  const close = vi.fn(),
    inspected = vi.fn()
  const view = render(
    <PluginEnvironmentRecoveryDialog
      intent={{ provider, operation }}
      onClose={close}
      onInspected={inspected}
    />
  )
  view.rerender(
    <PluginEnvironmentRecoveryDialog
      intent={{
        provider: { ...provider, configuration: { status: 'ready', contextId: 'other-account' } },
        operation: { ...operation, operationId: randomUUID() }
      }}
      onClose={close}
      onInspected={inspected}
    />
  )
  const check = screen.getByRole('button', { name: 'Check with provider' })
  act(() => {
    fireEvent.click(check)
    fireEvent.click(check)
  })
  expect(recover).toHaveBeenCalledOnce()
  const input = recover.mock.calls[0]?.[0]
  expect(input).toMatchObject({
    originalOperationId: operation.operationId,
    review: { ...provider.review, contextId: 'company/account/region' }
  })
  expect(input.queryId).not.toBe(operation.operationId)
  expect(input).not.toHaveProperty('requestDigest')
  expect(input).not.toHaveProperty('parameters')
  await userEvent.click(screen.getByRole('button', { name: 'Stop check' }))
  expect(cancel).toHaveBeenCalledExactlyOnceWith({ operationId: input.queryId })
  expect(screen.getByRole('alert').textContent).toContain('could not stop')
  await act(async () =>
    held.resolve({
      kind: 'inspected',
      operation,
      result: { kind: 'unverifiable', reason: 'cancelled' }
    })
  )
  expect(close).not.toHaveBeenCalled()
  expect(inspected).not.toHaveBeenCalled()
  expect(screen.getByRole('alert').textContent).toContain('unresolved')
})
it('treats a terminal provider confirmation as a refresh signal while retaining the original failed observation', async () => {
  const provider = environmentProviderUiFixture()
  const known: EnvironmentRecipeJournalOperation = {
    ...operation,
    status: 'completed',
    reason: undefined
  }
  const recover = vi.fn(async (): Promise<PluginEnvironmentProviderRecoveryResult> => ({
    kind: 'known',
    operation: known
  }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { plugins: { recoverEnvironmentProvider: recover } }
  })
  const close = vi.fn(),
    inspected = vi.fn()
  render(
    <PluginEnvironmentRecoveryDialog
      intent={{ provider, operation }}
      onClose={close}
      onInspected={inspected}
    />
  )
  await userEvent.click(screen.getByRole('button', { name: 'Check with provider' }))
  expect(inspected).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
})
