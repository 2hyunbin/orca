import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostAccountSignInStatus } from '../../../shared/host-account-sign-in-types'

const rpc = vi.hoisted(() => ({
  calls: [] as { method: string; params: unknown; revision: number | undefined }[],
  answer: (_method: string, _params: unknown): unknown => null
}))

vi.mock('./runtime-rpc-client', () => ({
  assertRuntimeEnvironmentCapability: vi.fn(async () => {}),
  callRuntimeRpc: vi.fn(
    async (
      _target: unknown,
      method: string,
      params: unknown,
      options: { expectedEnvironmentPairingRevision?: number }
    ) => {
      rpc.calls.push({ method, params, revision: options.expectedEnvironmentPairingRevision })
      return rpc.answer(method, params)
    }
  )
}))
vi.mock('./runtime-environment-revision', () => ({
  captureRuntimeEnvironmentRequestRevision: () => 7
}))

import {
  addCodexAccountOnHost,
  cancelHostAccountSignIn,
  readHostAccountSignIn
} from './runtime-host-account-sign-in-client'

const OWNER = { kind: 'environment', environmentId: 'server' } as const
const CODEX = { accounts: [], activeAccountId: null }

function status(patch: Partial<HostAccountSignInStatus>): HostAccountSignInStatus {
  return { flowId: 'flow-1', provider: 'codex', revision: 1, phase: 'starting', ...patch }
}

beforeEach(() => {
  rpc.calls.length = 0
})

describe('host account sign-in client', () => {
  it('pins every call to the pairing the sign-in started on and returns the added roster', async () => {
    rpc.answer = (method) =>
      method === 'accounts.hostSignInStart'
        ? status({})
        : status({ revision: 2, phase: 'signedIn', codex: CODEX })
    await expect(addCodexAccountOnHost(OWNER)).resolves.toEqual(CODEX)
    expect(rpc.calls.map((call) => call.method)).toEqual([
      'accounts.hostSignInStart',
      'accounts.hostSignInWait'
    ])
    expect(rpc.calls.every((call) => call.revision === 7)).toBe(true)
    expect(readHostAccountSignIn(OWNER, 'codex')).toBeNull()
  })

  it('applies a Cancel clicked before the host answered the start', async () => {
    const start = Promise.withResolvers<HostAccountSignInStatus>()
    rpc.answer = (method) =>
      method === 'accounts.hostSignInStart'
        ? start.promise
        : status({ revision: 2, phase: 'cancelled' })
    const adding = addCodexAccountOnHost(OWNER)
    await vi.waitFor(() => expect(rpc.calls).toHaveLength(1))
    await expect(cancelHostAccountSignIn(OWNER, 'codex')).resolves.toBe(true)
    start.resolve(status({}))
    await expect(adding).rejects.toThrow('Codex sign-in was cancelled.')
    expect(rpc.calls.map((call) => call.method)).toContain('accounts.hostSignInCancel')
  })
})
