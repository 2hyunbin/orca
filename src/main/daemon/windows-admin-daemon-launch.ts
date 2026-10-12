import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { getAppEnvironment } from '../../shared/app-environment'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'
import { DaemonEndpointOwnershipError, holdDaemonAdoptionLease } from './daemon-endpoint-adoption'
import { readDaemonPidRecord } from './daemon-endpoint-incarnation'
import { buildDaemonScriptArgs, type DaemonChildSpawnOptions } from './daemon-launched-child-spawn'
import { cleanupDaemonForProtocol } from './daemon-protocol-cleanup'
import type { DaemonProcessHandle } from './daemon-spawner'
import { PROTOCOL_VERSION } from './types'
import { DaemonClient } from './client'

export class WindowsAdminApprovalCanceledError extends Error {
  constructor() {
    super(
      'Administrator terminal canceled. Approve the Windows prompt to open an administrator PowerShell.'
    )
  }
}

export function windowsAdminLauncherPath(): string {
  const environment = getAppEnvironment()
  const bundled = process.resourcesPath
    ? getBundledLauncherPath('win32', process.resourcesPath)
    : join(environment.getPath('userData'), 'cli', 'bin', 'orca.exe')
  const development = join(
    environment.getAppPath(),
    'native',
    'windows-cli-launcher',
    '.build',
    'orca.exe'
  )
  const path = environment.isPackaged() ? bundled : development
  if (!path || !existsSync(path)) {
    throw new Error(
      'Administrator terminals require Orca’s native Windows launcher. Rebuild or reinstall Orca.'
    )
  }
  return path
}

export async function launchWindowsAdminDaemon(
  runtimeDir: string,
  options: DaemonChildSpawnOptions
): Promise<DaemonProcessHandle> {
  if (process.platform !== 'win32') {
    throw new Error('Administrator PowerShell terminals are supported only on Windows.')
  }
  const result = await runProcess({
    program: windowsAdminLauncherPath(),
    args: [
      '--orca-admin-terminal-host',
      options.relocatedExecPath ?? process.execPath,
      options.forkEntryPath,
      options.userDataPath,
      ...buildDaemonScriptArgs(options)
    ],
    timeoutMs: 120_000,
    maxOutputBytes: 8192
  })
  if (result.code === 1223) {
    throw new WindowsAdminApprovalCanceledError()
  }
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      result.stderr.trim() ||
        'Administrator terminal host could not start. Check the Windows approval prompt and try again.'
    )
  }
  return holdWindowsAdminDaemonLease(runtimeDir, options)
}

export async function holdWindowsAdminDaemonLease(
  runtimeDir: string,
  options: DaemonChildSpawnOptions
): Promise<DaemonProcessHandle> {
  const deadline = Date.now() + 10_000
  const client = new DaemonClient({
    socketPath: options.socketPath,
    tokenPath: options.tokenPath
  })
  let failure = new Error('Administrator terminal host ownership could not be verified.')
  do {
    // Pipe creation precedes PID/token publication; authenticate only the requested incarnation.
    const record = readDaemonPidRecord(options.pidPath)
    if (record?.launchNonce === options.launchNonce && record.startedAtMs !== null) {
      try {
        await client.ensureConnectedWithin(Math.max(1, deadline - Date.now()))
        return await holdDaemonAdoptionLease(
          {
            shutdown: async () => {
              await cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION, record.pid)
            }
          },
          {
            socketPath: options.socketPath,
            tokenPath: options.tokenPath,
            pidPath: options.pidPath,
            connectedClient: client,
            expectedIdentity: {
              pid: record.pid,
              startedAtMs: record.startedAtMs,
              launchNonce: options.launchNonce
            }
          }
        )
      } catch (error) {
        client.disconnect()
        if (error instanceof DaemonEndpointOwnershipError) {
          throw error
        }
        failure = error instanceof Error ? error : failure
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw failure
}
