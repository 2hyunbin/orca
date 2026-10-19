import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from './remote-exec/remote-exec-command'
import type * as RecordFile from '../managed-server/install/orcad-remote-record-file'
import type * as InstallLock from '../managed-server/install/remote-install-lock'
import type * as VersionedInstall from '../managed-server/install/remote-versioned-install'

vi.mock('./remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
vi.mock('../../shared/shell-argument-quoting', () => ({ quotePosixShell: (s: string) => `'${s}'` }))
vi.mock('../managed-server/install/remote-install-lock', async (importOriginal) => ({
  ...(await importOriginal<typeof InstallLock>()),
  acquireInstallLock: vi.fn()
}))
vi.mock('../managed-server/install/orcad-remote-record-file', async (importOriginal) => ({
  ...(await importOriginal<typeof RecordFile>()),
  writeAtomicOrcadRemoteRecord: vi.fn()
}))
vi.mock('../managed-server/install/remote-versioned-install', async (importOriginal) => ({
  ...(await importOriginal<typeof VersionedInstall>()),
  readLocalFullVersion: () => '0.2.0+bb01'
}))
vi.mock('../managed-server/install/orcad-remote-install', () => ({ installOrcadBundle: vi.fn() }))
vi.mock('../managed-server/install/orcad-remote-preflight', () => ({
  preflightInstalledOrcad: vi.fn()
}))
vi.mock('./orcad-local-build-hash', () => ({
  computeLocalOrcadBuildHash: () => 'abc123def4567890'
}))

import { execCommand } from './remote-exec/remote-exec-command'
import { acquireInstallLock } from '../managed-server/install/remote-install-lock'
import { writeAtomicOrcadRemoteRecord } from '../managed-server/install/orcad-remote-record-file'
import { deployOrcad } from './orcad-remote-deploy'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { ORCAD_SNAPSHOT_SPACE_INSUFFICIENT_CODE } from './orcad-snapshot-room'
import {
  FakeOrcadHost,
  NEW,
  OLD
} from '../managed-server/activation/orcad-activation-host-test-harness'

let host = FakeOrcadHost.deployedOld()

/** The host's answer to the room check: KB the state needs, KB a prune frees, and `df`'s line. */
function answerRoom(neededKb: number, reclaimKb: number, availableKb: number): void {
  vi.mocked(execCommand).mockImplementation(async (_conn, command) =>
    command.includes('SNAPSHOT_SPACE')
      ? `SNAPSHOT_SPACE ${neededKb} ${reclaimKb} /dev/sda1 100 1 ${availableKb} 1% /home\n`
      : host.exec(command)
  )
}

const deploy = () =>
  deployOrcad({
    conn: Object.create(null),
    host: getRemoteHostPlatform('linux-x64'),
    remoteHome: '/home/work',
    nodePath: '/usr/bin/node',
    userDataDir: '/home/work/.orca',
    bindHost: '127.0.0.1',
    port: 7777,
    readinessTimeoutMs: 50,
    sleep: async () => {},
    now: () => new Date('2026-02-02T00:00:00.000Z'),
    localOrcadDir: '/local/out/orcad',
    target: 'linux-x64-glibc217',
    census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 }
  })

beforeEach(() => {
  vi.clearAllMocks()
  host = FakeOrcadHost.deployedOld()
  vi.mocked(acquireInstallLock).mockImplementation(async (_conn, dir, _host, options) => {
    if (!host.acquireFence(options)) {
      const { RemoteInstallLockBusyError } = await vi.importActual<typeof InstallLock>(
        '../managed-server/install/remote-install-lock'
      )
      throw new RemoteInstallLockBusyError(dir, 0)
    }
  })
  vi.mocked(writeAtomicOrcadRemoteRecord).mockImplementation(async (_target, path, contents) =>
    host.write(path, contents)
  )
})

describe('an update on a host without room for its snapshot (#30491)', () => {
  it('keeps the running server and says how much to free, stopping nothing', async () => {
    answerRoom(400_000, 0, 1_000)

    const result = await deploy()

    expect(result).toMatchObject({
      outcome: 'installed-not-activated',
      code: ORCAD_SNAPSHOT_SPACE_INSUFFICIENT_CODE
    })
    expect(JSON.stringify(result)).toMatch(
      /has 1000 KB free, and the snapshot needs about 390\.6 MB.*keeps running the current server \(0\.1\.0\+aa01\)/u
    )
    expect([...host.alive]).toEqual([OLD])
    expect(host.activeVersion()).toBe(OLD)
    expect(host.commands.some((command) => command.includes('kill -TERM'))).toBe(false)
    expect(host.journal).toBeNull()
    expect(host.fence).toBe(false)
  })

  it('updates when pruning earlier snapshots makes the room', async () => {
    answerRoom(400_000, 500_000, 1_000)

    expect(await deploy()).toMatchObject({ outcome: 'installed-and-activated' })
    expect(host.activeVersion()).toBe(NEW)
  })
})
