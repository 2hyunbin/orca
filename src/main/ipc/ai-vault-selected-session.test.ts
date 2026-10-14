import { expect, it, vi } from 'vitest'
import { resolveSelectedSessionByHost } from './ai-vault-selected-session'
import { AI_VAULT_SELECTED_SESSION_CAPABILITY } from '../../shared/ai-vault-selected-session'
import { listResult } from '../ai-vault/structured-session-ownership.test-support'

const mocks = vi.hoisted(() => ({ status: vi.fn(), call: vi.fn() }))
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: () => ({ id: 'server-1', pairingRevision: 1, createdAt: 1 })
}))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('./runtime-environment-transport-routing', () => ({
  getRuntimeEnvironmentStatus: mocks.status,
  callRuntimeEnvironment: mocks.call
}))
it('capable hosts use selected RPC even when listing is broken; failures never fall back', async () => {
  mocks.status.mockResolvedValue({
    ok: true,
    result: { capabilities: [AI_VAULT_SELECTED_SESSION_CAPABILITY] }
  })
  mocks.call.mockResolvedValue({ ok: false, error: { message: 'Unreadable saved conversation' } })
  const local = vi.fn()
  await expect(
    resolveSelectedSessionByHost(
      {
        source: { kind: 'chat', sessionId: 'chat-1', workspaceId: 'workspace-1' },
        executionHostId: 'runtime:server-1',
        requestToken: 'token-1'
      },
      local,
      '/profile'
    )
  ).rejects.toThrow('Unreadable')
  expect(mocks.call).toHaveBeenCalledExactlyOnceWith(
    '/profile',
    'server-1',
    'aiVault.resolveSession',
    expect.any(Object),
    15_000,
    1,
    undefined,
    { signal: expect.any(AbortSignal) }
  )
  expect(local).not.toHaveBeenCalled()
})
it('older paired host keeps its existing own-host row and abortable caller without local work', async () => {
  vi.clearAllMocks()
  const listed = listResult()
  listed.sessions[0] = {
    ...listed.sessions[0]!,
    structuredSession: { sessionId: 'chat-1', workspaceId: 'workspace-1' }
  }
  mocks.status.mockResolvedValue({ ok: true, result: { capabilities: [] } })
  mocks.call.mockResolvedValue({ ok: true, result: listed })
  const local = vi.fn()
  const source = { kind: 'chat', sessionId: 'chat-1', workspaceId: 'workspace-1' } as const
  const args = { source, executionHostId: 'runtime:server-1', requestToken: 'token-1' } as const
  expect(await resolveSelectedSessionByHost(args, local, '/profile')).toMatchObject({
    status: 'ready',
    session: { executionHostId: 'runtime:server-1', structuredSession: { sessionId: 'chat-1' } }
  })
  expect(mocks.call.mock.calls[0]?.[2]).toBe('aiVault.listSessions')
  const controller = new AbortController()
  mocks.call.mockReturnValue(new Promise(() => {}))
  const pending = resolveSelectedSessionByHost(args, local, '/profile', controller.signal)
  await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
  controller.abort()
  await expect(pending).rejects.toThrow()
  expect(local).not.toHaveBeenCalled()
})
