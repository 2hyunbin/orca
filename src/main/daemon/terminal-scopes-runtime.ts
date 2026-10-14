/** The daemon's terminal scopes and process ceiling, applied to every PTY spawn it makes. */
import { existsSync } from 'node:fs'
import { userManagerEnv } from './daemon-cgroup-scope'
import { setPtyActiveProcessLimit } from '../windows/windows-pty-job'
import { resolveTerminalScopes, type TerminalScopeRuntime } from './terminal-scopes'
import type { PtyProcessCeilingState } from '../../shared/pty-process-ceiling-state'

let currentState: PtyProcessCeilingState = { state: 'off', reason: 'disabled' }
let currentScopes: TerminalScopeRuntime | null = null
let scopeCounter = 0

/** Daemon start: decide, remember for every spawn, and return what the pid record reports. */
export function initializeTerminalScopes(
  launchId: string,
  daemonScope: string | null,
  log: (event: string, details?: Record<string, unknown>) => void
): PtyProcessCeilingState {
  const resolved = resolveTerminalScopes({
    env: process.env,
    platform: process.platform,
    launchId: launchId || `${process.pid}`,
    daemonScope,
    setWindowsLimit: setPtyActiveProcessLimit
  })
  setTerminalScopesForTest(resolved.ceiling, resolved.linux)
  if (process.platform === 'linux') {
    log(
      'terminal-scopes',
      resolved.linux
        ? { slice: resolved.linux.slice, properties: resolved.linux.properties }
        : { off: resolved.offReason }
    )
  }
  return resolved.ceiling
}

export function setTerminalScopesForTest(
  state: PtyProcessCeilingState,
  scopes: TerminalScopeRuntime | null
): void {
  currentState = state
  currentScopes = scopes
}

export function currentPtyProcessCeiling(): PtyProcessCeilingState {
  return currentState
}

const SESSION_KEYS = ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'] as const

/**
 * Linux with terminal scopes: exec through `systemd-run --scope`, which keeps the pid and exit
 * status, into this terminal's own scope. `systemd-run` talks to the user manager the daemon
 * verified; `env` then gives the shell its own session variables back. Off, it is the identity.
 */
export function wrapPtySpawnInTerminalScope(
  file: string,
  args: string[],
  env: Record<string, string>,
  sliceExists: (path: string) => boolean = existsSync
): { file: string; args: string[]; env: Record<string, string> } {
  const scopes = currentScopes
  if (!scopes) {
    return { file, args, env }
  }
  // Why: `systemd-run --slice` would silently recreate a stopped slice unbound and unlimited.
  if (!sliceExists(scopes.sliceCgroupPath)) {
    setTerminalScopesForTest(
      currentState.state === 'on' ? { state: 'off', reason: 'slice_lost' } : currentState,
      null
    )
    return { file, args, env }
  }
  scopeCounter += 1
  const managerEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(userManagerEnv(env))) {
    if (typeof value === 'string' && key !== 'DBUS_SESSION_BUS_ADDRESS') {
      managerEnv[key] = value
    }
  }
  const unsets: string[] = []
  const sets: string[] = []
  for (const key of SESSION_KEYS) {
    if (env[key] !== managerEnv[key]) {
      if (env[key] === undefined) {
        unsets.push('-u', key)
      } else {
        sets.push(`${key}=${env[key]}`)
      }
    }
  }
  return {
    file: scopes.systemdRun,
    args: [
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      `--slice=${scopes.slice}`,
      `--unit=orca_pty_${scopes.launchId}_${scopeCounter}.scope`,
      ...scopes.properties.map((property) => `--property=${property}`),
      '--',
      ...(unsets.length + sets.length > 0 ? [scopes.envBinary, ...unsets, ...sets] : []),
      file,
      ...args
    ],
    env: managerEnv
  }
}
