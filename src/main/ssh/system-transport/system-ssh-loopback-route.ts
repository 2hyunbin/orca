/**
 * Connection reuse for proxied targets where OpenSSH cannot multiplex (Windows has no ControlMaster).
 * One held `ssh -N -L` pays the ProxyCommand/ProxyJump handshake once; later commands log in over
 * 127.0.0.1 through it instead of re-running the proxy for every exec.
 */
import type { ChildProcessHandle as ChildProcess } from '@orca/process-host/process-spec'
import { createSshOperationAbortError } from '../connection/ssh-exec-options'
import type { SshTarget } from '../../../shared/ssh-types'
import { terminateWindowsProcessTree } from '../../windows-process-tree-kill'
import type { SshResolvedConfig } from '../config/ssh-g-config-resolution'
import type { SystemSshBuildArgsOptions, SystemSshLoopbackRouteArgs } from './system-ssh-args'
import { spawnSystemSshCommand } from './system-ssh-command'
import {
  startSystemSshPortForwardProcess,
  waitForSystemSshForwardStartup
} from './system-ssh-forward-process'

// Why long: the forward pays the full proxy handshake, which is the slow part this route exists for.
export const SYSTEM_SSH_LOOPBACK_ROUTE_LISTEN_TIMEOUT_MS = 60_000
export const SYSTEM_SSH_LOOPBACK_ROUTE_PROBE_TIMEOUT_MS = 15_000
const LOOPBACK_ROUTE_PROBE_MARKER = 'ORCA-SYSTEM-SSH-LOOPBACK-OK'

export type SystemSshLoopbackRoute = {
  args: SystemSshLoopbackRouteArgs
  onExit: (callback: () => void) => void
  dispose: () => void
}

export function shouldUseSystemSshLoopbackRoute(
  target: SshTarget,
  resolved: SshResolvedConfig | null,
  options: SystemSshBuildArgsOptions,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32' || target.systemSshConnectionReuse === false) {
    return false
  }
  // Why: Kerberos derives the service principal from the dialled host name, which becomes 127.0.0.1.
  if (options.gssapiOnly || target.gssapiAuthentication || resolved?.gssapiAuthentication) {
    return false
  }
  // Why: an unclaimed alias already rewrites HostName/Port to the stored endpoint.
  if (options.aliasClaimedByConfig === false) {
    return false
  }
  return Boolean(
    resolved?.proxyCommand || resolved?.proxyJump || target.proxyCommand || target.jumpHost
  )
}

/** Known-hosts name OpenSSH would have used for the proxied route, so trust carries over. */
export function getLoopbackRouteHostKeyAlias(
  target: SshTarget,
  resolved: SshResolvedConfig | null
): string {
  if (resolved?.hostKeyAlias) {
    return resolved.hostKeyAlias
  }
  const host = resolved?.hostname || target.host
  const port = resolved?.port || target.port || 22
  return port === 22 ? host : `[${host}]:${port}`
}

export async function startSystemSshLoopbackRoute(
  target: SshTarget,
  resolved: SshResolvedConfig | null,
  options: SystemSshBuildArgsOptions,
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal
): Promise<SystemSshLoopbackRoute> {
  signal?.throwIfAborted()
  const remotePort = resolved?.port || target.port || 22
  // Why: the forward itself must take the real proxy route, never an existing loopback one.
  const forward = await startSystemSshPortForwardProcess(
    target,
    0,
    'localhost',
    remotePort,
    { ...options, loopbackRoute: undefined },
    signal
  )
  let disposed = false
  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    stopLoopbackForward(forward.process, forward.dispose, platform)
  }
  signal?.addEventListener('abort', dispose, { once: true })
  try {
    signal?.throwIfAborted()
    await waitForSystemSshForwardStartup(
      forward.process,
      forward.localPort,
      SYSTEM_SSH_LOOPBACK_ROUTE_LISTEN_TIMEOUT_MS,
      signal
    )
    const args = {
      localPort: forward.localPort,
      hostKeyAlias: getLoopbackRouteHostKeyAlias(target, resolved)
    }
    // Why: a listening forward does not prove sshd allows it (AllowTcpForwarding) or that auth works over it.
    await probeLoopbackRoute(target, { ...options, loopbackRoute: args }, signal)
    signal?.throwIfAborted()
    return {
      args,
      onExit: (callback) => {
        // Why: the forward can exit between the probe and this registration, after 'exit' already fired.
        if (forward.process.exitCode !== null || forward.process.signalCode !== null) {
          callback()
          return
        }
        forward.process.once('exit', callback)
      },
      dispose
    }
  } catch (error) {
    dispose()
    throw error
  } finally {
    signal?.removeEventListener('abort', dispose)
  }
}

function stopLoopbackForward(
  forwardProcess: ChildProcess,
  killForward: () => void,
  platform: NodeJS.Platform
): void {
  if (forwardProcess.exitCode !== null || forwardProcess.signalCode !== null) {
    return
  }
  const pid = forwardProcess.pid
  if (platform !== 'win32' || !pid) {
    killForward()
    return
  }
  // Why: Windows does not end a killed ssh's ProxyCommand child, which would keep the proxy tunnel open.
  void terminateWindowsProcessTree(pid, { site: 'system-ssh-loopback-route' }).then((stopped) => {
    if (!stopped && forwardProcess.exitCode === null && forwardProcess.signalCode === null) {
      killForward()
    }
  })
}

function probeLoopbackRoute(
  target: SshTarget,
  options: SystemSshBuildArgsOptions,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const channel = spawnSystemSshCommand(target, `echo ${LOOPBACK_ROUTE_PROBE_MARKER}`, {
    ...options,
    nonInteractive: true,
    wrapCommand: false
  })
  return new Promise((resolve, reject) => {
    let stdout = ''
    let settled = false
    const finish = (error?: Error, closeChannel = false): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      channel.off('data', onData)
      channel.off('close', onClose)
      if (error) {
        if (closeChannel) {
          channel.close()
        }
        reject(error)
      } else {
        resolve()
      }
    }
    const onAbort = (): void => finish(createSshOperationAbortError(), true)
    const onData = (data: Buffer): void => {
      stdout += data.toString('utf-8')
    }
    const onClose = (code: number | null): void => {
      finish(
        code === 0 && stdout.includes(LOOPBACK_ROUTE_PROBE_MARKER)
          ? undefined
          : new Error(`System SSH loopback route probe failed (exit ${code ?? 'unknown'})`)
      )
    }
    const timeout = setTimeout(() => {
      finish(new Error('System SSH loopback route probe timed out'), true)
    }, SYSTEM_SSH_LOOPBACK_ROUTE_PROBE_TIMEOUT_MS)
    channel.on('data', onData)
    channel.stderr.resume()
    channel.once('error', (error: Error) => finish(error, true))
    channel.once('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
  })
}
