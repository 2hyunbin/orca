import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { InFlightPromiseDedupe } from '../../shared/in-flight-promise-dedupe'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { renameFileWithWindowsRetryAsync } from '../../shared/windows-retry-file-operations'
import {
  isConfiguredTerminalLimit,
  terminalLimitInputMaximum,
  type TerminalLimitStatus
} from '../../shared/terminal-limit-policy'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'
import { isSafeOwnedDirectory } from '../../shared/owned-private-directory'
import { awaitDaemonValueWithinCallerDeadline } from './daemon-request-deadline'
import { DEFAULT_MAX_HOST_TERMINALS, resolveMaxHostTerminals } from './host-terminal-ledger'
import { SystemPtyLimit } from './system-pty-limit'

export function hostTerminalPolicyPath(home: string, machine: string | null): string | null {
  if (!machine) {
    return null
  }
  const key = createHash('sha256')
    .update(`${process.platform}:${machine}`)
    .digest('hex')
    .slice(0, 16)
  return join(home, '.orca', 'host-settings', key, 'terminals.json')
}

async function readSavedMaximum(path: string): Promise<number | null> {
  try {
    const { buffer, stats } = await readNodeFileWithinLimit(path, 1024, { regularFileOnly: true })
    if (process.getuid && stats.uid !== process.getuid()) {
      throw new Error('Policy owner changed')
    }
    const saved: unknown = JSON.parse(buffer.toString('utf8'))
    if (
      typeof saved !== 'object' ||
      saved === null ||
      !('schemaVersion' in saved) ||
      saved.schemaVersion !== 1 ||
      !('maxTerminals' in saved) ||
      !isConfiguredTerminalLimit(saved.maxTerminals)
    ) {
      throw new Error('Invalid terminal policy')
    }
    return saved.maxTerminals
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export class HostTerminalPolicy {
  private readonly reads = new InFlightPromiseDedupe<number | null>(0, 1)
  private writing = false
  private readonly environment: number | null

  constructor(
    readonly path: string | null = hostTerminalPolicyPath(
      homedir(),
      profileStateAccessMachineIdentity()
    ),
    env: NodeJS.ProcessEnv = process.env,
    private readonly system = new SystemPtyLimit(),
    private readonly readSaved: (path: string) => Promise<number | null> = readSavedMaximum
  ) {
    const raw = env.ORCA_DAEMON_MAX_HOST_TERMINALS?.trim()
    this.environment =
      raw && /^\d+$/.test(raw) && isConfiguredTerminalLimit(Number(raw))
        ? resolveMaxHostTerminals(env)
        : null
  }

  private saved(): Promise<number | null> {
    const path = this.path
    return path ? this.reads.run('policy', () => this.readSaved(path)) : Promise.resolve(null)
  }

  async admissionMaximum(): Promise<number> {
    if (this.environment !== null) {
      return this.environment
    }
    try {
      const read = await awaitDaemonValueWithinCallerDeadline(this.saved(), Date.now() + 250)
      return (read.completed ? read.value : null) ?? DEFAULT_MAX_HOST_TERMINALS
    } catch {
      // Settings storage cannot prevent a user from starting a terminal.
      return DEFAULT_MAX_HOST_TERMINALS
    }
  }

  async status(daemonNonce: string): Promise<TerminalLimitStatus> {
    const [saved, systemPtyLimit] = await Promise.all([
      this.environment === null ? this.saved() : Promise.resolve(null),
      this.system.read()
    ])
    return {
      maxTerminals: this.environment ?? saved ?? DEFAULT_MAX_HOST_TERMINALS,
      source: this.environment !== null ? 'environment' : saved !== null ? 'saved' : 'default',
      systemPtyLimit,
      editable: this.environment === null && this.path !== null,
      daemonNonce
    }
  }

  async save(maximum: number, isCurrent: () => boolean): Promise<void> {
    if (!this.path || this.environment !== null || this.writing) {
      throw new Error('Terminal setting unavailable')
    }
    this.writing = true
    let temporary: string | undefined
    try {
      // A read that started before the write must settle before authoritative readback.
      await this.saved()
      const ceiling = terminalLimitInputMaximum(await this.system.read())
      if (!isConfiguredTerminalLimit(maximum) || maximum > ceiling) {
        throw new Error('Terminal limit exceeds host capacity')
      }
      const directory = dirname(this.path)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if (!isSafeOwnedDirectory(await lstat(directory))) {
        throw new Error('Terminal policy directory is not private')
      }
      temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, maxTerminals: maximum }), {
        flag: 'wx',
        mode: 0o600
      })
      if (!(await renameFileWithWindowsRetryAsync(temporary, this.path, isCurrent))) {
        throw new Error('Terminal host changed')
      }
    } finally {
      if (temporary) {
        await rm(temporary, { force: true }).catch(() => undefined)
      }
      this.writing = false
    }
  }
}
