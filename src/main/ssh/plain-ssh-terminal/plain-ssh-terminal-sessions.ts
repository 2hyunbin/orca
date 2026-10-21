/**
 * Plain SSH terminals: an unmanaged `ssh` login to a host whose move to its Orca server is blocked,
 * so the user can keep working there meanwhile. A session is not an Orca workspace or terminal:
 * nothing persists or restores it, no agent or status runs in it, and it never marks the host
 * connected. One per host; it ends when ssh exits, its window closes, or Orca quits.
 */
import { randomUUID } from 'node:crypto'
import type * as pty from 'node-pty'
import type { SshTarget } from '../../../shared/ssh-types'
import type {
  PlainSshTerminalEvent,
  PlainSshTerminalOpenResult
} from '../../../shared/plain-ssh-terminal'
import { buildInheritedLocalPtyEnvironment } from '../../providers/local-pty-spawn-environment'
import { spawnPtyExecutable } from '../../providers/local-pty-utils'
import { destroyPtyProcess } from '../../providers/local-pty-termination'
import { buildPlainSshTerminalArgs } from './plain-ssh-terminal-args'

export type PlainSshTerminalDeps = {
  getTarget: (targetId: string) => SshTarget | undefined
  /** True only while the host's move to its Orca server is blocked. */
  isMoveBlocked: (targetId: string) => boolean
  findSsh: () => string | null
  mayConfigClaimAlias: (alias: string) => boolean
  loadPtySpawn: () => Promise<typeof pty.spawn>
  homeDir: () => string
  platform: NodeJS.Platform
}

/** Where a session's output and exit go; false once that window is gone. */
export type PlainSshTerminalSink = (event: PlainSshTerminalEvent) => boolean

type Session = {
  id: string
  targetId: string
  owner: number
  proc: pty.IPty
  exited: boolean
  forceKill?: ReturnType<typeof setTimeout>
}

const FORCE_KILL_AFTER_MS = 5_000
const MIN_SIZE = 2
const MAX_SIZE = 1_000

const sessions = new Map<string, Session>()

function sshMissingMessage(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? 'Orca couldn’t find OpenSSH (ssh.exe) on this computer. Install “OpenSSH Client” in Windows Settings > System > Optional features, then try again.'
    : 'Orca couldn’t find ssh on this computer. Install the OpenSSH client, then try again.'
}

function clampSize(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.floor(value)))
    : fallback
}

export async function openPlainSshTerminal(
  deps: PlainSshTerminalDeps,
  request: { targetId: unknown; cols: unknown; rows: unknown; owner: number },
  sink: PlainSshTerminalSink
): Promise<PlainSshTerminalOpenResult> {
  const targetId = typeof request.targetId === 'string' ? request.targetId : ''
  const target = targetId ? deps.getTarget(targetId) : undefined
  // Why `owner`: internal targets (a server's own SSH hops) are never the user's host.
  if (!target || target.owner) {
    return { ok: false, reason: 'unknown-target' }
  }
  if (!deps.isMoveBlocked(target.id)) {
    return { ok: false, reason: 'not-blocked' }
  }
  const existing = [...sessions.values()].find((session) => session.targetId === target.id)
  if (existing) {
    return { ok: false, reason: 'already-open', sessionId: existing.id }
  }
  const sshPath = deps.findSsh()
  if (!sshPath) {
    return { ok: false, reason: 'ssh-missing', message: sshMissingMessage(deps.platform) }
  }
  const args = buildPlainSshTerminalArgs(
    target,
    target.configHost && !deps.mayConfigClaimAlias(target.configHost)
      ? { aliasClaimedByConfig: false }
      : undefined
  )
  let proc: pty.IPty
  try {
    proc = spawnPtyExecutable({
      file: sshPath,
      args,
      cols: clampSize(request.cols, 80),
      rows: clampSize(request.rows, 24),
      cwd: deps.homeDir(),
      env: buildInheritedLocalPtyEnvironment(undefined),
      ptySpawn: await deps.loadPtySpawn()
    })
  } catch (error) {
    return {
      ok: false,
      reason: 'spawn-failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }
  const session: Session = {
    id: randomUUID(),
    targetId: target.id,
    owner: request.owner,
    proc,
    exited: false
  }
  sessions.set(session.id, session)
  proc.onData((data) => {
    if (!sink({ kind: 'data', sessionId: session.id, data })) {
      closePlainSshTerminal(session.id, session.owner)
    }
  })
  proc.onExit(({ exitCode }) => {
    session.exited = true
    clearTimeout(session.forceKill)
    sessions.delete(session.id)
    destroyPtyProcess(proc, { alreadyKilled: true })
    sink({ kind: 'exit', sessionId: session.id, exitCode })
  })
  return { ok: true, sessionId: session.id, label: target.label }
}

function ownedSession(sessionId: unknown, owner: number): Session | null {
  const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
  return session && session.owner === owner && !session.exited ? session : null
}

export function writePlainSshTerminal(sessionId: unknown, owner: number, data: unknown): void {
  const session = ownedSession(sessionId, owner)
  if (session && typeof data === 'string') {
    session.proc.write(data)
  }
}

export function resizePlainSshTerminal(
  sessionId: unknown,
  owner: number,
  cols: unknown,
  rows: unknown
): void {
  const session = ownedSession(sessionId, owner)
  if (session) {
    session.proc.resize(clampSize(cols, session.proc.cols), clampSize(rows, session.proc.rows))
  }
}

/** Hangs up ssh; its exit event follows, and a stuck one is killed outright. */
export function closePlainSshTerminal(sessionId: unknown, owner: number): void {
  const session = ownedSession(sessionId, owner)
  if (!session || session.forceKill) {
    return
  }
  try {
    session.proc.kill()
  } catch {
    // Already gone; onExit cleans up.
  }
  session.forceKill = setTimeout(() => {
    if (!session.exited) {
      try {
        session.proc.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }, FORCE_KILL_AFTER_MS)
  session.forceKill.unref?.()
}

/** Every session a window owns, e.g. when it closes or reloads. */
export function closePlainSshTerminalsOwnedBy(owner: number): void {
  for (const session of sessions.values()) {
    if (session.owner === owner) {
      closePlainSshTerminal(session.id, owner)
    }
  }
}

/** On quit: nothing outlives Orca, since nothing would ever restore it. */
export function closeAllPlainSshTerminals(): void {
  for (const session of sessions.values()) {
    closePlainSshTerminal(session.id, session.owner)
  }
}
