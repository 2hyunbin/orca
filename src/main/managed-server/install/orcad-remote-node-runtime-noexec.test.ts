import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import {
  createExecProbedStageCommand,
  ensureRemoteOrcadNodeRuntime
} from './orcad-remote-node-runtime'
import {
  assertRemoteNodeRuntimePromoted,
  REMOTE_NODE_RUNTIME_MISSING,
  REMOTE_NODE_RUNTIME_NOEXEC
} from '../../ssh/orcad-remote-node-runtime-report'
import { classifyOrcadHostUnavailable } from '../../orcad/orcad-host-unavailable'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { uploadRelayDirectory } from './remote-install-transfers'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
vi.mock('./remote-install-transfers', () => ({ uploadRelayDirectory: vi.fn(async () => {}) }))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every remote call goes through the mocked execCommand.
const conn = {} as OrcadHostTransport
const host = getRemoteHostPlatform('linux-x64')
// What dash printed for the probe on a Docker host whose /root is a `noexec` tmpfs.
const NOEXEC_SHELL_WORDS =
  'exit 126: /bin/sh: 1: /root/.orca-remote/runtimes/.stage-node-x-1/.exec-probe: Permission denied'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.mocked(execCommand).mockReset()
  vi.mocked(uploadRelayDirectory).mockClear()
})

describe('pinned-Node runtime store on a host that refuses to run programs', () => {
  it.skipIf(process.platform === 'win32')(
    'reports nothing and leaves no probe behind where programs may run',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orcad-runtime-noexec-'))
      directories.push(root)
      const stage = join(root, 'runtimes', '.stage-node-x-1')
      const result = runProcessSync({
        program: '/bin/sh',
        args: ['-c', createExecProbedStageCommand(host, stage)],
        timeoutMs: 30_000
      })
      expect(result.code).toBe(0)
      expect(result.stdout.trim()).toBe('')
      expect(existsSync(stage)).toBe(true)
      expect(readdirSync(stage)).toEqual([])
    }
  )

  it('names the noexec store before fetching or uploading the ~40 MiB runtime', async () => {
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes(REMOTE_NODE_RUNTIME_MISSING)) {
        return REMOTE_NODE_RUNTIME_MISSING
      }
      if (command.includes('.exec-probe')) {
        return `${REMOTE_NODE_RUNTIME_NOEXEC}\n${NOEXEC_SHELL_WORDS}`
      }
      return ''
    })
    const archivePath = vi.fn(async () => '/never/fetched.tar.gz')

    const failure = await ensureRemoteOrcadNodeRuntime({
      conn,
      host,
      slotDir: '/root/.orca-remote/orcad-0.1.0+abc',
      target: 'linux-x64-glibc',
      archivePath
    }).catch((error: unknown) => error)

    expect(classifyOrcadHostUnavailable(failure)).toBe('runtime_noexec')
    expect(String(failure)).toContain('/root/.orca-remote/runtimes')
    expect(archivePath).not.toHaveBeenCalled()
    expect(uploadRelayDirectory).not.toHaveBeenCalled()
  })

  it('reads an exec refusal at the self-test as noexec, not an unsupported runtime', () => {
    const refused = () =>
      assertRemoteNodeRuntimePromoted(
        'ORCA_NODE_RUNTIME_SELFTEST_FAILED\nORCA_RUNTIME_EXIT=126\n' +
          'sh: 1: /root/.orca-remote/runtimes/.stage/node-v24/bin/node: Permission denied'
      )
    const wrongLibc = () =>
      assertRemoteNodeRuntimePromoted(
        'ORCA_NODE_RUNTIME_SELFTEST_FAILED\nORCA_RUNTIME_EXIT=127\n' +
          'Error loading shared library libstdc++.so.6: No such file or directory'
      )
    expect(classifyOrcadHostUnavailable(catchError(refused))).toBe('runtime_noexec')
    expect(classifyOrcadHostUnavailable(catchError(wrongLibc))).toBe('runtime_self_test')
  })
})

function catchError(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return null
}
