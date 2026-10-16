// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, params?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => params?.[name] ?? '')
}))

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  checkLinearConnection: vi.fn(async () => {}),
  checkJiraConnection: vi.fn(async () => {})
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/lib/default-creation-host', () => ({
  defaultScopeHost: (settings: { activeRuntimeEnvironmentId: string | null }) =>
    settings.activeRuntimeEnvironmentId
      ? { kind: 'environment', environmentId: settings.activeRuntimeEnvironmentId }
      : { kind: 'local' }
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      runtimeEnvironments: [{ id: 'env-1', name: 'm4air' }],
      checkLinearConnection: mocks.checkLinearConnection,
      checkJiraConnection: mocks.checkJiraConnection
    })
}))

const { KeychainCredentialNotice } = await import('./keychain-credential-notice')

describe('KeychainCredentialNotice', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('names the host and the locked Keychain instead of asking to reconnect', () => {
    render(
      <KeychainCredentialNotice
        service="Jira"
        status={{ credentialErrorReason: 'keychain_locked' }}
      />
    )
    const text = screen.getByRole('alert').textContent ?? ''
    expect(text).toContain('Jira is unavailable on m4air: its macOS login Keychain is locked.')
    expect(text).toContain('Sign in to that Mac at its screen once')
    expect(text).not.toMatch(/reconnect/i)
    // No switch while locked: the key cannot be read to move it.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers the switch to file storage once unlocked, then refreshes both providers', async () => {
    mocks.callRuntimeRpc.mockResolvedValueOnce({ ok: true })
    render(
      <KeychainCredentialNotice service="Linear" status={{ canMoveCredentialKeyToFile: true }} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Switch to file storage' }))
    await waitFor(() => expect(mocks.checkJiraConnection).toHaveBeenCalled())
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'integrationCredentials.moveKeyToFile',
      undefined,
      { timeoutMs: 15_000 }
    )
    expect(mocks.checkLinearConnection).toHaveBeenCalledWith(true)
  })

  it('renders nothing for a host that reports neither field', () => {
    const { container } = render(<KeychainCredentialNotice service="Linear" status={{}} />)
    expect(container.textContent).toBe('')
  })
})
