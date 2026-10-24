/**
 * Whether a proxied target may switch to the loopback route. Fails closed: the route is only a
 * speedup, so any doubt keeps the direct proxy route.
 */
import { dirname, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshResolvedConfig } from '../config/ssh-g-config-resolution'
import { requiresSystemSshForSecurityKey } from '../ssh-transport-selection'
import {
  buildSshArgs,
  type SystemSshBuildArgsOptions,
  type SystemSshLoopbackRouteArgs
} from './system-ssh-args'
import { findSystemSsh } from './system-ssh-binary'

const LOOPBACK_ROUTE_ADMISSION_TIMEOUT_MS = 5_000

// Why: these are exactly what the route rewrites; any other difference means ssh_config matched
// differently once HostName became 127.0.0.1 (e.g. `Match host`), so commands would change identity.
const ROUTE_REWRITTEN_SSH_G_KEYS = new Set([
  'hostname',
  'port',
  'hostkeyalias',
  'proxycommand',
  'proxyjump'
])

export type LoopbackRouteAdmission = { admitted: true } | { admitted: false; reason: string }

export async function admitSystemSshLoopbackRoute(
  target: SshTarget,
  resolved: SshResolvedConfig | null,
  options: SystemSshBuildArgsOptions,
  route: SystemSshLoopbackRouteArgs
): Promise<LoopbackRouteAdmission> {
  const sshPath = findSystemSsh()
  if (!sshPath) {
    return { admitted: false, reason: 'no system ssh binary' }
  }
  const [direct, routed] = await Promise.all([
    readEffectiveSshConfig(sshPath, buildSshArgs(target, { ...options, loopbackRoute: undefined })),
    readEffectiveSshConfig(sshPath, buildSshArgs(target, { ...options, loopbackRoute: route }))
  ])
  if (!direct || !routed) {
    return { admitted: false, reason: 'ssh -G failed' }
  }
  const drifted = findConfigDrift(direct, routed)
  if (drifted.length > 0) {
    return { admitted: false, reason: `route changes ${drifted.join(', ')}` }
  }
  // Why: every security-key login asks for a touch, so the forward and probe would add unprompted ones.
  if (await requiresSystemSshForSecurityKey(target, resolved)) {
    return { admitted: false, reason: 'security-key identity file' }
  }
  if (await agentMayHoldSecurityKey(sshPath, direct)) {
    return { admitted: false, reason: 'agent may hold a security key' }
  }
  return { admitted: true }
}

/** Each `ssh -G` line keyed by option; repeated options (IdentityFile, SendEnv…) keep every value. */
export function parseSshGLines(stdout: string): Map<string, string[]> {
  const options = new Map<string, string[]>()
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    const space = line.indexOf(' ')
    if (space === -1) {
      continue
    }
    const key = line.slice(0, space).toLowerCase()
    options.set(key, [...(options.get(key) ?? []), line.slice(space + 1).trim()])
  }
  return options
}

export function findConfigDrift(
  direct: Map<string, string[]>,
  routed: Map<string, string[]>
): string[] {
  const keys = new Set([...direct.keys(), ...routed.keys()])
  return [...keys]
    .filter((key) => !ROUTE_REWRITTEN_SSH_G_KEYS.has(key))
    .filter((key) => (direct.get(key) ?? []).join('\n') !== (routed.get(key) ?? []).join('\n'))
    .sort()
}

/**
 * `ssh-add -L` lists sk- key types. An unreachable default agent can sign nothing; an unreachable
 * configured IdentityAgent may only be a path ssh-add resolved differently, so it fails closed.
 */
export function agentListingMayHoldSecurityKey(
  result: { code: number | null; stdout: string; timedOut: boolean },
  agentConfigured: boolean
): boolean {
  if (result.timedOut) {
    return true
  }
  if (result.code === 0) {
    return result.stdout.split(/\r?\n/).some((line) => line.trim().startsWith('sk-'))
  }
  // Why: exit 1 is "The agent has no identities"; exit 2 is "could not connect to the agent".
  return !(result.code === 1 || (result.code === 2 && !agentConfigured))
}

async function agentMayHoldSecurityKey(
  sshPath: string,
  direct: Map<string, string[]>
): Promise<boolean> {
  const identityAgent = direct.get('identityagent')?.[0]
  if (identityAgent?.toLowerCase() === 'none') {
    return false
  }
  const sshAddPath = join(
    dirname(sshPath),
    process.platform === 'win32' ? 'ssh-add.exe' : 'ssh-add'
  )
  const agentConfigured = Boolean(identityAgent && identityAgent !== 'SSH_AUTH_SOCK')
  const env = agentConfigured ? { ...process.env, SSH_AUTH_SOCK: identityAgent } : process.env
  try {
    return agentListingMayHoldSecurityKey(
      await runProcess({
        program: sshAddPath,
        args: ['-L'],
        env,
        timeoutMs: LOOPBACK_ROUTE_ADMISSION_TIMEOUT_MS
      }),
      agentConfigured
    )
  } catch {
    return true
  }
}

async function readEffectiveSshConfig(
  sshPath: string,
  args: string[]
): Promise<Map<string, string[]> | null> {
  try {
    const result = await runProcess({
      program: sshPath,
      args: ['-G', ...args],
      timeoutMs: LOOPBACK_ROUTE_ADMISSION_TIMEOUT_MS
    })
    return result.code === 0 && !result.timedOut ? parseSshGLines(result.stdout) : null
  } catch {
    return null
  }
}
