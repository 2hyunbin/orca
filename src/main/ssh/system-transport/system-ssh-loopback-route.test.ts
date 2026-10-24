import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock, spawnMock, connectMock, createServerMock, treeKillMock } = vi.hoisted(
  () => ({
    existsSyncMock: vi.fn(),
    spawnMock: vi.fn(),
    connectMock: vi.fn(),
    createServerMock: vi.fn(),
    treeKillMock: vi.fn()
  })
)

vi.mock('../../windows-process-tree-kill', () => ({
  terminateWindowsProcessTree: treeKillMock
}))

vi.mock('./system-ssh-orphaned-forward', () => ({
  stopOrphanedOrcaSshForward: vi.fn().mockResolvedValue(false)
}))

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, existsSync: existsSyncMock }
})

vi.mock('child_process', () => ({ spawn: spawnMock }))

vi.mock('net', () => ({ connect: connectMock, createServer: createServerMock }))

import type { SshTarget } from '../../../shared/ssh-types'
import type { SshResolvedConfig } from '../config/ssh-g-config-resolution'
import { buildSshArgs, getSystemSshBuildArgsFromOperationOptions } from './system-ssh-args'
import {
  getLoopbackRouteHostKeyAlias,
  shouldUseSystemSshLoopbackRoute,
  startSystemSshLoopbackRoute
} from './system-ssh-loopback-route'

const SYSTEM_SSH_PATH =
  process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : '/usr/bin/ssh'
const FREE_PORT = 49811
const ROUTE = { localPort: FREE_PORT, hostKeyAlias: 'devbox' }

function createTarget(overrides?: Partial<SshTarget>): SshTarget {
  return {
    id: 'target-1',
    label: 'Dev box',
    host: 'devbox',
    configHost: 'devbox',
    port: 22,
    username: '',
    source: 'ssh-config',
    ...overrides
  }
}

function createResolved(overrides?: Partial<SshResolvedConfig>): SshResolvedConfig {
  return {
    hostname: 'devbox',
    port: 22,
    identityFile: [],
    identitiesOnly: false,
    forwardAgent: false,
    proxyCommand: 'aws ssm start-session --target %h',
    proxyUseFdpass: false,
    controlMaster: 'no',
    controlPersist: 'no',
    userKnownHostsFiles: [],
    globalKnownHostsFiles: [],
    strictHostKeyChecking: 'ask',
    hashKnownHosts: false,
    updateHostKeys: 'no',
    ...overrides
  }
}

type FakeProcess = EventEmitter & {
  pid: number | undefined
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
  exitCode: number | null
  signalCode: NodeJS.Signals | null
}

function createFakeProcess(): FakeProcess {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields are assigned on the next lines, before the process is returned.
  const proc = new EventEmitter() as FakeProcess
  proc.pid = 4242
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.kill = vi.fn().mockReturnValue(true)
  proc.exitCode = null
  proc.signalCode = null
  return proc
}

function createFakeServer() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields are assigned on the next lines, before the server is returned.
  const server = new EventEmitter() as EventEmitter & {
    listen: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    address: ReturnType<typeof vi.fn>
  }
  server.listen = vi.fn().mockImplementation(() => {
    queueMicrotask(() => server.emit('listening'))
    return server
  })
  server.address = vi.fn(() => ({ address: '127.0.0.1', port: FREE_PORT }))
  server.close = vi.fn().mockImplementation((cb?: () => void) => cb?.())
  return server
}

function createListeningSocket(): EventEmitter {
  const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() })
  queueMicrotask(() => socket.emit('connect'))
  return socket
}

/** The probe command over the route answers like a remote shell with this exit code. */
function answerProbe(proc: FakeProcess, code: number): void {
  setImmediate(() => {
    if (code === 0) {
      proc.stdout.write('ORCA-SYSTEM-SSH-LOOPBACK-OK\n')
    }
    proc.stdout.end()
    proc.emit('exit', code, null)
    proc.emit('close', code, null)
  })
}

function spawnedArgs(call: number): string[] {
  return spawnMock.mock.calls[call]?.[1] ?? []
}

describe('buildSshArgs with a loopback route', () => {
  it('dials the held forward ahead of the alias so OpenSSH keeps these over ssh_config', () => {
    const args = buildSshArgs(createTarget(), { loopbackRoute: ROUTE })
    const routeStart = args.indexOf('HostName=127.0.0.1')

    expect(routeStart).toBeGreaterThan(-1)
    expect(args.slice(routeStart - 1, routeStart + 9)).toEqual([
      '-o',
      'HostName=127.0.0.1',
      '-o',
      `Port=${FREE_PORT}`,
      '-o',
      'ProxyCommand=none',
      '-o',
      'ProxyJump=none',
      '-o',
      'HostKeyAlias=devbox'
    ])
    expect(args.slice(-2)).toEqual(['--', 'devbox'])
  })

  it("drops a manual target's own port and proxies, which would fight the route", () => {
    const args = buildSshArgs(
      createTarget({
        source: 'manual',
        configHost: undefined,
        host: 'devbox.internal',
        port: 2200,
        username: 'dev',
        jumpHost: 'bastion',
        proxyCommand: 'cloudflared access ssh --hostname %h'
      }),
      { loopbackRoute: ROUTE }
    )

    expect(args).not.toContain('-J')
    expect(args).not.toContain('-p')
    expect(args.filter((arg) => arg.startsWith('ProxyCommand='))).toEqual(['ProxyCommand=none'])
    expect(args.slice(-2)).toEqual(['--', 'dev@devbox.internal'])
  })

  it('carries the route into file-transfer operations', () => {
    expect(getSystemSshBuildArgsFromOperationOptions({ loopbackRoute: ROUTE })).toEqual({
      loopbackRoute: ROUTE
    })
  })
})

describe('shouldUseSystemSshLoopbackRoute', () => {
  it.each([
    ['a ProxyCommand host on Windows', createTarget(), createResolved(), {}, 'win32', true],
    [
      'a ProxyJump host on Windows',
      createTarget(),
      createResolved({ proxyCommand: undefined, proxyJump: 'bastion' }),
      {},
      'win32',
      true
    ],
    [
      'a direct host on Windows',
      createTarget(),
      createResolved({ proxyCommand: undefined }),
      {},
      'win32',
      false
    ],
    ['macOS, which multiplexes instead', createTarget(), createResolved(), {}, 'darwin', false],
    ['Linux, which multiplexes instead', createTarget(), createResolved(), {}, 'linux', false],
    [
      'a host that opted out of connection reuse',
      createTarget({ systemSshConnectionReuse: false }),
      createResolved(),
      {},
      'win32',
      false
    ],
    [
      'a Kerberos host',
      createTarget(),
      createResolved({ gssapiAuthentication: true }),
      {},
      'win32',
      false
    ],
    [
      'an alias no Host block claims',
      createTarget(),
      createResolved(),
      { aliasClaimedByConfig: false },
      'win32',
      false
    ]
  ] as const)('%s → %s', (_name, target, resolved, options, platform, expected) => {
    expect(shouldUseSystemSshLoopbackRoute(target, resolved, options, platform)).toBe(expected)
  })
})

describe('getLoopbackRouteHostKeyAlias', () => {
  it("keeps the known_hosts name OpenSSH used for the proxied route's host and port", () => {
    expect(
      getLoopbackRouteHostKeyAlias(createTarget(), createResolved({ hostname: 'i-0abc' }))
    ).toBe('i-0abc')
    expect(
      getLoopbackRouteHostKeyAlias(
        createTarget(),
        createResolved({ hostname: 'i-0abc', port: 2222 })
      )
    ).toBe('[i-0abc]:2222')
  })

  it("prefers the user's own HostKeyAlias", () => {
    expect(
      getLoopbackRouteHostKeyAlias(createTarget(), createResolved({ hostKeyAlias: 'pinned' }))
    ).toBe('pinned')
  })
})

describe('startSystemSshLoopbackRoute', () => {
  beforeEach(() => {
    existsSyncMock.mockReset().mockImplementation((p: string) => p === SYSTEM_SSH_PATH)
    spawnMock.mockReset()
    connectMock.mockReset().mockImplementation(createListeningSocket)
    createServerMock.mockReset().mockImplementation(createFakeServer)
    treeKillMock.mockReset().mockResolvedValue(true)
  })

  it('opens the forward over the real proxy, then proves a login over the route', async () => {
    const forward = createFakeProcess()
    const probe = createFakeProcess()
    spawnMock.mockReturnValueOnce(forward).mockImplementationOnce(() => {
      answerProbe(probe, 0)
      return probe
    })

    const route = await startSystemSshLoopbackRoute(
      createTarget(),
      createResolved(),
      { loopbackRoute: { localPort: 1, hostKeyAlias: 'stale' } },
      'linux'
    )

    expect(route.args).toEqual(ROUTE)
    expect(spawnedArgs(0)).toContain(`127.0.0.1:${FREE_PORT}:localhost:22`)
    expect(spawnedArgs(0)).not.toContain('ProxyCommand=none')
    expect(spawnedArgs(1)).toContain(`Port=${FREE_PORT}`)
    expect(spawnedArgs(1)).toContain('ProxyCommand=none')
    expect(spawnedArgs(1)).toContain('BatchMode=yes')
    expect(forward.kill).not.toHaveBeenCalled()
  })

  it('stops the forward when sshd refuses logins over it', async () => {
    const forward = createFakeProcess()
    const probe = createFakeProcess()
    spawnMock.mockReturnValueOnce(forward).mockImplementationOnce(() => {
      answerProbe(probe, 255)
      return probe
    })

    await expect(
      startSystemSshLoopbackRoute(createTarget(), createResolved(), {}, 'linux')
    ).rejects.toThrow('loopback route probe failed (exit 255)')
    expect(forward.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('gives up without a probe when the forward exits before listening', async () => {
    const forward = createFakeProcess()
    spawnMock.mockReturnValueOnce(forward)
    connectMock.mockImplementation(() => {
      const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() })
      queueMicrotask(() => socket.emit('error', new Error('ECONNREFUSED')))
      return socket
    })

    const pending = startSystemSshLoopbackRoute(createTarget(), createResolved(), {}, 'linux')
    setImmediate(() => {
      forward.stderr.write('kex_exchange_identification: Connection closed by remote host\n')
      forward.emit('exit', 255)
    })

    await expect(pending).rejects.toThrow('Connection closed by remote host')
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  // Why: killing ssh.exe leaves its ProxyCommand child running, still holding the proxy tunnel open.
  it('stops the whole forward process tree on Windows, falling back to the direct kill', async () => {
    const forward = createFakeProcess()
    const probe = createFakeProcess()
    spawnMock.mockReturnValueOnce(forward).mockImplementationOnce(() => {
      answerProbe(probe, 0)
      return probe
    })
    const route = await startSystemSshLoopbackRoute(createTarget(), createResolved(), {}, 'win32')

    treeKillMock.mockResolvedValueOnce(false)
    route.dispose()

    expect(treeKillMock).toHaveBeenCalledWith(4242, { site: 'system-ssh-loopback-route' })
    await vi.waitFor(() => expect(forward.kill).toHaveBeenCalledWith('SIGTERM'))
  })

  it('reports a forward that already exited before anyone listened for it', async () => {
    const forward = createFakeProcess()
    const probe = createFakeProcess()
    spawnMock.mockReturnValueOnce(forward).mockImplementationOnce(() => {
      answerProbe(probe, 0)
      return probe
    })
    const route = await startSystemSshLoopbackRoute(createTarget(), createResolved(), {}, 'linux')
    forward.exitCode = 255
    forward.emit('exit', 255)

    const onExit = vi.fn()
    route.onExit(onExit)

    expect(onExit).toHaveBeenCalledTimes(1)
  })
  it.each(['exit', 'signal'] as const)('does not kill a forward after %s', async (reason) => {
    const forward = createFakeProcess()
    const probe = createFakeProcess()
    spawnMock.mockReturnValueOnce(forward).mockImplementationOnce(() => {
      answerProbe(probe, 0)
      return probe
    })
    const route = await startSystemSshLoopbackRoute(createTarget(), createResolved(), {}, 'win32')
    if (reason === 'exit') {
      forward.exitCode = 255
    } else {
      forward.signalCode = 'SIGTERM'
    }
    forward.emit('exit', forward.exitCode, forward.signalCode)
    route.dispose()
    route.dispose()
    expect(treeKillMock).not.toHaveBeenCalled()
    expect(forward.kill).not.toHaveBeenCalled()
  })
  it('cancels listener polling and closes its socket without waiting for child exit', async () => {
    vi.useFakeTimers()
    try {
      const forward = createFakeProcess()
      const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() })
      spawnMock.mockReturnValueOnce(forward)
      connectMock.mockReturnValue(socket)
      const controller = new AbortController()
      const pending = startSystemSshLoopbackRoute(
        createTarget(),
        createResolved(),
        {},
        'linux',
        controller.signal
      )
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.advanceTimersByTimeAsync(50)
      expect(connectMock).toHaveBeenCalledTimes(1)
      controller.abort()
      await rejected
      expect(forward.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(socket.destroy).toHaveBeenCalledTimes(1)
      expect(socket.eventNames()).toEqual([])
      expect(forward.listenerCount('error')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(connectMock).toHaveBeenCalledTimes(1)
      expect(spawnMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the login probe and forward without waiting for probe timeout', async () => {
    vi.useFakeTimers()
    try {
      const forward = createFakeProcess()
      const probe = createFakeProcess()
      spawnMock.mockReturnValueOnce(forward).mockReturnValueOnce(probe)
      const controller = new AbortController()
      const pending = startSystemSshLoopbackRoute(
        createTarget(),
        createResolved(),
        {},
        'linux',
        controller.signal
      )
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.advanceTimersByTimeAsync(50)
      expect(spawnMock).toHaveBeenCalledTimes(2)
      controller.abort()
      await rejected
      expect(forward.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(probe.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not spawn a forward if cancelled during port reservation', async () => {
    const server = createFakeServer()
    createServerMock.mockReturnValueOnce(server)
    server.listen.mockImplementationOnce(() => server)
    const controller = new AbortController()
    const pending = startSystemSshLoopbackRoute(
      createTarget(),
      createResolved(),
      {},
      'linux',
      controller.signal
    )
    controller.abort()
    server.emit('listening')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('disposes a live Windows route once and avoids fallback after child exit', async () => {
    const forward = createFakeProcess()
    const probe = createFakeProcess()
    spawnMock.mockReturnValueOnce(forward).mockImplementationOnce(() => {
      answerProbe(probe, 0)
      return probe
    })
    const route = await startSystemSshLoopbackRoute(createTarget(), createResolved(), {}, 'win32')
    let finishKill = (_stopped: boolean): void => {}
    treeKillMock.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishKill = resolve
        })
    )
    route.dispose()
    route.dispose()
    expect(treeKillMock).toHaveBeenCalledTimes(1)
    forward.exitCode = 255
    forward.emit('exit', 255)
    finishKill(false)
    await Promise.resolve()
    expect(forward.kill).not.toHaveBeenCalled()
  })
  it('uses direct cleanup for a live forward with no PID', async () => {
    const forward = createFakeProcess()
    forward.pid = undefined
    const probe = createFakeProcess()
    spawnMock.mockReturnValueOnce(forward).mockImplementationOnce(() => {
      answerProbe(probe, 0)
      return probe
    })
    const route = await startSystemSshLoopbackRoute(createTarget(), createResolved(), {}, 'win32')
    route.dispose()
    route.dispose()
    expect(treeKillMock).not.toHaveBeenCalled()
    expect(forward.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  })
  it('closes a live login probe when its output stream errors', async () => {
    vi.useFakeTimers()
    try {
      const forward = createFakeProcess()
      const probe = createFakeProcess()
      spawnMock.mockReturnValueOnce(forward).mockReturnValueOnce(probe)
      const pending = startSystemSshLoopbackRoute(createTarget(), createResolved(), {}, 'linux')
      const rejected = expect(pending).rejects.toThrow('probe output failed')
      await vi.advanceTimersByTimeAsync(50)
      probe.stdout.emit('error', new Error('probe output failed'))
      await rejected
      expect(probe.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(forward.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
