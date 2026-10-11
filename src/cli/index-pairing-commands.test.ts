import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import { okFixture, queueFixtures } from './test-fixtures'

const LINK = 'orca://pair#c2VjcmV0'

describe('orca pairing commands', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('prints only the link on stdout and passes the TTL in milliseconds', async () => {
    queueFixtures(
      callMock,
      okFixture('req_ticket', {
        ticketId: 'abc123abc123',
        code: 'c2VjcmV0',
        link: LINK,
        scope: 'runtime',
        issuedAt: 0,
        expiresAt: 900_000
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['pairing', 'create', '--ttl', '15m'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('pairing.createTicket', { ttlMs: 900_000 })
    expect(logSpy.mock.calls).toEqual([[LINK]])
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('c2VjcmV0')
  })

  it('rejects a TTL above one hour before contacting the runtime', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['pairing', 'create', '--ttl', '2h', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument', message: expect.stringContaining('cannot exceed 1h') }
    })
    process.exitCode = priorExitCode
  })

  it('refuses to mint on a remote environment', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['pairing', 'create', '--pairing-code', 'remote', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    process.exitCode = priorExitCode
  })

  it('lists and revokes tickets by id', async () => {
    queueFixtures(
      callMock,
      okFixture('req_list', {
        tickets: [
          {
            ticketId: 'abc123abc123',
            scope: 'runtime',
            issuedVia: 'owner-cli',
            requiresApproval: false,
            state: 'open',
            issuedAt: 0,
            expiresAt: 0
          }
        ]
      }),
      okFixture('req_revoke', { revoked: true })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['pairing', 'list'], '/tmp/repo')
    await main(['pairing', 'revoke', 'abc123abc123'], '/tmp/repo')

    expect(String(logSpy.mock.calls[0]?.[0])).toContain('abc123abc123  runtime  owner-cli  open')
    expect(callMock).toHaveBeenLastCalledWith('pairing.revokeTicket', { ticketId: 'abc123abc123' })
    expect(logSpy.mock.calls[1]).toEqual(['Revoked pairing link abc123abc123.'])
  })
})
