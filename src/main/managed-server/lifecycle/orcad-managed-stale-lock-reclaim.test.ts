import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { sshCommandExitError } from '../../ssh/remote-exec/remote-exec-command'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { ORCAD_INSTALL_MODEL } from '../install/remote-install-model'
import { computeRemoteInstallDir } from '../install/remote-versioned-install'

const mocks = vi.hoisted(() => {
  const host: { current: RemoteHostPlatform | null } = { current: null }
  const home = { current: '/home/dev' }
  return { host, home, exec: vi.fn(), wake: vi.fn(), rebuild: vi.fn(async () => {}) }
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
    remoteHome: mocks.home.current,
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

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.home.current = '/home/dev'
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

  // Runs the real command in a shell against a slot whose runtime records any invocation.
  it.skipIf(process.platform === 'win32').each([
    ['never starts an orcad whose bundle lacks the flag', 'orcad server', false],
    ['runs the slot that names the flag', 'argv[2] === "--reclaim-stale-lock"', true]
  ])('%s', async (_case, bundle, invoked) => {
    const home = mkdtempSync(join(tmpdir(), 'orcad-reclaim-gate-'))
    roots.push(home)
    mocks.home.current = home
    const slotDir = computeRemoteInstallDir(ORCAD_INSTALL_MODEL, home, '1.0.0')
    mkdirSync(slotDir, { recursive: true })
    writeFileSync(join(slotDir, 'orcad-server.js'), bundle)
    writeFileSync(join(slotDir, '.build-target'), 'linux-x64')
    const runtime = join(slotDir, 'bun-runtime')
    writeFileSync(runtime, `#!/bin/sh\ntouch ${quotePosixShell(join(home, 'invoked'))}\n`)
    chmodSync(runtime, 0o755)
    mocks.exec.mockImplementation(async (_slot: unknown, command: string) => {
      const { stdout } = await runProcess({ program: '/bin/sh', args: ['-c', command] })
      return stdout
    })
    const result = await runManagedOrcadStaleLockReclaim('/u', 'env-1', { yes: true })
    expect(result.status).toBe('unsupported')
    expect(existsSync(join(home, 'invoked'))).toBe(invoked)
  })
})
