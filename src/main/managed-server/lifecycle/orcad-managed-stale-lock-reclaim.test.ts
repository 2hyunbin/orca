import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { sshCommandExitError } from '../../ssh/remote-exec/remote-exec-command'

const mocks = vi.hoisted(() => {
  const host: { current: RemoteHostPlatform | null } = { current: null }
  return { host, exec: vi.fn(), wake: vi.fn(), rebuild: vi.fn(async () => {}) }
})

vi.mock('../../ssh/orcad-runtime-maintenance', () => ({
  withManagedOrcadLifecycle: (
    _path: string,
    _selector: string,
    run: (managed: unknown) => Promise<unknown>
  ) => run({ environment: { id: 'env-1' }, deployment: { remotePort: 7777 } })
}))
vi.mock('./orcad-managed-runtime-context', () => ({
  resolveLinkedOrcadContext: async () => ({ host: mocks.host.current }),
  managedOrcadSlot: () => ({
    host: mocks.host.current,
    remoteHome: '/home/dev',
    userDataDir: '/home/dev/.orca'
  })
}))
vi.mock('../activation/orcad-activation-lock', () => ({
  withOrcadActivationLock: (_slot: unknown, run: () => Promise<unknown>) => run()
}))
vi.mock('../activation/orcad-activation-record-store', () => ({
  readOrcadActivationRecord: async () => ({ active: '1.0.0' })
}))
vi.mock('./orcad-managed-wake', () => ({ wakeStoppedManagedOrcad: mocks.wake }))
vi.mock('./orcad-managed-tunnel', () => ({ rebuildOrcadManagedTunnel: mocks.rebuild }))
vi.mock('../install/orcad-remote-runtime-control', () => ({ execOrcadRemote: mocks.exec }))

const { runManagedOrcadStaleLockReclaim } = await import('./orcad-managed-stale-lock-reclaim')

const evidence = { pid: 41, host: 'box', bootId: 'b1', currentBootId: 'b2', ageMinutes: 90 }
const answer = (status: string, extra: object = {}) =>
  JSON.stringify({ status, lockPath: '/home/dev/.orca/orcad.lock', message: status, ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.host.current = getRemoteHostPlatform('linux-x64')
  mocks.wake.mockResolvedValue({ outcome: 'started', readiness: {} })
})

describe('runManagedOrcadStaleLockReclaim', () => {
  it('reads the dry run’s evidence from the command’s exit-2 output', async () => {
    mocks.exec.mockRejectedValue(
      sshCommandExitError('orcad', 2, `${answer('eligible', { exitCode: 2, evidence })}\n`)
    )
    await expect(runManagedOrcadStaleLockReclaim('/u', 'env-1', { yes: false })).resolves.toEqual({
      status: 'eligible',
      lockPath: '/home/dev/.orca/orcad.lock',
      message: 'eligible',
      evidence
    })
    const command: string = mocks.exec.mock.calls[0][1]
    expect(command).toContain("--reclaim-stale-lock --data-root '/home/dev/.orca' --json")
    expect(command).not.toContain('--yes')
    expect(mocks.wake).not.toHaveBeenCalled()
  })

  it('never guesses from an orcad that answers without JSON', async () => {
    mocks.exec.mockRejectedValue(sshCommandExitError('orcad', 1, 'Error: lock held'))
    const result = await runManagedOrcadStaleLockReclaim('/u', 'env-1', { yes: true })
    expect(result.status).toBe('unsupported')
    expect(mocks.wake).not.toHaveBeenCalled()
  })

  it('runs nothing on a host whose starts never refuse a shared-home lock', async () => {
    mocks.host.current = getRemoteHostPlatform('darwin-arm64')
    const result = await runManagedOrcadStaleLockReclaim('/u', 'env-1', { yes: true })
    expect(result.status).toBe('unsupported')
    expect(mocks.exec).not.toHaveBeenCalled()
  })

  it('starts the server again once the confirmed reclaim cleared the lock', async () => {
    mocks.exec.mockResolvedValue(`${answer('reclaimed', { exitCode: 0 })}\n`)
    const result = await runManagedOrcadStaleLockReclaim('/u', 'env-1', { yes: true })
    expect(mocks.exec.mock.calls[0][1]).toContain('--json --yes')
    expect(result).toMatchObject({ status: 'reclaimed', environmentId: 'env-1' })
    expect(result).not.toHaveProperty('notRestarted')
    expect(mocks.wake).toHaveBeenCalledOnce()
    expect(mocks.rebuild).toHaveBeenCalledWith('/u', 'env-1')
  })
})
