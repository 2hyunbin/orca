import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type {
  PtySpawnOptions,
  PtySpawnResult,
  PtyProcessInfo
} from '../providers/pty-provider-contract'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { createOutOfProcessLauncher } from './daemon-out-of-process-launcher'
import { getDaemonHistoryDir } from './daemon-launch-paths'
import { ensurePrivateDir } from './daemon-private-file-modes'
import {
  DaemonSpawner,
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath
} from './daemon-spawner'
import { releaseDaemonAdoptionLease } from './daemon-endpoint-adoption'
import { readDaemonPidRecord } from './daemon-endpoint-incarnation'
import { isDaemonEndpointGoneError } from './daemon-errors'
import { inspectProcessSignal } from './daemon-process-inspection'
import { WindowsAdminApprovalCanceledError } from './windows-admin-daemon-launch'
import type { SessionInfo } from './types'
import type { DaemonIdleRetirementResult } from './daemon-pty-runtime-state'

export function getWindowsAdminDaemonRuntimeDir(): string {
  const directory = join(getAppEnvironment().getPath('userData'), 'daemon-admin')
  ensurePrivateDir(directory)
  return directory
}

export class WindowsAdminPtyAdapter extends DaemonPtyAdapter {
  override readonly windowsAdministrator = true as const
  private launchInFlight: Promise<void> | null = null
  private readonly spawner: DaemonSpawner

  constructor(runtimeDir: string) {
    super({
      socketPath: getDaemonSocketPath(runtimeDir),
      tokenPath: getDaemonTokenPath(runtimeDir),
      pidPath: getDaemonPidPath(runtimeDir),
      profileScope: runtimeDir,
      runtimeDir,
      historyPath: getDaemonHistoryDir()
    })
    // Background inventories and input recovery must never raise Windows consent prompts.
    this.spawner = new DaemonSpawner({
      runtimeDir,
      launcher: createOutOfProcessLauncher(runtimeDir, {
        windowsAdministrator: true
      })
    })
  }

  override async spawn(options: PtySpawnOptions): Promise<PtySpawnResult> {
    if (!options.attachOnly) {
      if (options.spawnIntent === 'automatic-restore' || options.spawnIntent === 'automation') {
        try {
          await this.establishLifecycleLease()
        } catch {
          throw new Error(
            'Administrator terminal host is unavailable. Open a new PowerShell terminal to approve Windows elevation, then retry.'
          )
        }
        return super.spawn(options)
      }
      if (!this.launchInFlight) {
        this.launchInFlight = this.ensureAdminHost().finally(() => {
          this.launchInFlight = null
        })
      }
      await this.launchInFlight
    }
    return super.spawn(options)
  }

  override listProcesses(options?: { deadlineMs?: number }): Promise<PtyProcessInfo[]> {
    return this.hasNeverLaunched()
      ? Promise.resolve([])
      : this.emptyWhenHostGone(super.listProcesses(options))
  }

  override listSessions(): Promise<SessionInfo[]> {
    return this.hasNeverLaunched()
      ? Promise.resolve([])
      : this.emptyWhenHostGone(super.listSessions())
  }

  // A crash, logoff or reboot leaves the PID/token files; an absent pipe plus a missing PID proves
  // the host is gone. A live elevated host reports EPERM, so this still fails closed.
  private async emptyWhenHostGone<T>(inventory: Promise<T[]>): Promise<T[]> {
    try {
      return await inventory
    } catch (error) {
      const record = readDaemonPidRecord(this.pidPath)
      if (
        this.launchInFlight ||
        !isDaemonEndpointGoneError(error) ||
        (record && inspectProcessSignal(record.pid) !== 'missing')
      ) {
        throw error
      }
      for (const path of [this.pidPath, this.tokenPath]) {
        if (path) {
          rmSync(path, { force: true })
        }
      }
      return []
    }
  }

  override requestIdleRetirement(): Promise<DaemonIdleRetirementResult> {
    return this.hasNeverLaunched()
      ? Promise.resolve({ state: 'retiring' })
      : super.requestIdleRetirement()
  }

  private hasNeverLaunched(): boolean {
    return (
      !this.launchInFlight &&
      !this.lastAuthenticatedIdentity &&
      !existsSync(this.tokenPath) &&
      (!this.pidPath || !existsSync(this.pidPath))
    )
  }

  private async ensureAdminHost(): Promise<void> {
    if (this.client.isConnected()) {
      return
    }
    this.spawner.resetHandle()
    try {
      await this.spawner.ensureRunning()
    } catch (error) {
      // Declining the prompt is a user choice, not a crash; keep it out of the crash-loop window.
      if (error instanceof WindowsAdminApprovalCanceledError) {
        this.spawner.resetRespawnWindow()
      }
      throw error
    }
    try {
      await this.establishLifecycleLease()
    } finally {
      releaseDaemonAdoptionLease(this.spawner.getHandle())
    }
  }
}
