import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  supportsCapability: vi.fn()
}))

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.call,
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

import { closeStructuredAgentSession } from './structured-agent-session-close'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'

beforeEach(() => {
  vi.clearAllMocks()
  replaceRuntimeEnvironmentRevisions([])
  mocks.call.mockResolvedValue({ ok: true })
  mocks.supportsCapability.mockResolvedValue(true)
})

describe('closeStructuredAgentSession', () => {
  it('closes a local session without a redundant capability probe', async () => {
    await expect(closeStructuredAgentSession({ kind: 'local' }, 'codex-session-1')).resolves.toBe(
      'closed'
    )

    expect(mocks.supportsCapability).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'local' },
      'agentSession.close',
      { sessionId: 'codex-session-1' },
      { expectedEnvironmentPairingRevision: undefined }
    )
  })

  it('closes through a paired host that advertises the structured session surface', async () => {
    const target = { kind: 'environment', environmentId: 'env-1' } as const

    await expect(closeStructuredAgentSession(target, 'claude-session-1')).resolves.toBe('closed')

    expect(mocks.call).toHaveBeenCalledWith(
      target,
      'agentSession.close',
      { sessionId: 'claude-session-1' },
      { expectedEnvironmentPairingRevision: undefined }
    )
  })

  it('keeps the command on the pairing captured before the capability probe', async () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 0, pairingRevision: 3 }])
    let compatible!: (value: boolean) => void
    mocks.supportsCapability.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          compatible = resolve
        })
    )
    const close = closeStructuredAgentSession(
      { kind: 'environment', environmentId: 'env-1' },
      'same-session'
    )
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 0, pairingRevision: 4 }])
    compatible(true)
    await close
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'agentSession.close',
      { sessionId: 'same-session' },
      { expectedEnvironmentPairingRevision: 3 }
    )
  })

  it('does not send an unknown method to a legacy paired host', async () => {
    mocks.supportsCapability.mockResolvedValue(false)

    await expect(
      closeStructuredAgentSession(
        { kind: 'environment', environmentId: 'legacy-env' },
        'codex-session-1'
      )
    ).resolves.toBe('unsupported')

    expect(mocks.call).not.toHaveBeenCalled()
  })
})
