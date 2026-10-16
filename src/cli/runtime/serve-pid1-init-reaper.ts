import { existsSync } from 'node:fs'

const BASH_CANDIDATES = ['/bin/bash', '/usr/bin/bash']

/**
 * Runs as PID 1: bash's wait reaps every exited child, including orphans the kernel reparents to
 * it, which Node cannot do (#28147). PID 1 ignores untrapped signals, so each is forwarded.
 * The served command runs in a forked subshell, so it is never PID 1 itself.
 * Why the subshell: async commands in a non-interactive shell otherwise start with INT/QUIT ignored.
 */
export const SERVE_INIT_REAPER_SCRIPT = [
  '(trap - INT QUIT; exec "$@") 0<&0 &',
  'child=$!',
  'for sig in TERM INT HUP QUIT USR1 USR2; do trap "kill -$sig $child 2>/dev/null" "$sig"; done',
  'while :; do',
  '  wait "$child"; status=$?',
  '  kill -0 "$child" 2>/dev/null || break',
  'done',
  'exit "$status"'
].join('\n')

export type ServeInitReaperDeps = {
  platform: NodeJS.Platform
  pid: number
  env: NodeJS.ProcessEnv
  execPath: string
  argv: readonly string[]
  exists: (path: string) => boolean
  execve: ((file: string, args: string[], env: NodeJS.ProcessEnv) => void) | null
  warn: (line: string) => void
}

export type ServeInitReaperOutcome = 'not-pid1' | 'reexec' | 'unavailable'

const NO_REAPER_WARNING =
  '[serve] Orca is PID 1 and cannot reap orphaned processes, so they stay zombies. Run it under an init (docker run --init, tini, or bash).'

/** Replaces a PID 1 Linux serve with bash supervising the same command; returns only when it did not. */
export function reexecServeUnderInitReaper(deps: ServeInitReaperDeps): ServeInitReaperOutcome {
  if (deps.platform !== 'linux' || deps.pid !== 1) {
    return 'not-pid1'
  }
  const bash = BASH_CANDIDATES.find((candidate) => deps.exists(candidate))
  if (!bash || !deps.execve) {
    deps.warn(NO_REAPER_WARNING)
    return 'unavailable'
  }
  try {
    deps.execve(
      bash,
      [
        'bash',
        '-c',
        SERVE_INIT_REAPER_SCRIPT,
        'orca-serve-init',
        deps.execPath,
        ...deps.argv.slice(1)
      ],
      deps.env
    )
  } catch (error) {
    deps.warn(`${NO_REAPER_WARNING} (${error instanceof Error ? error.message : String(error)})`)
    return 'unavailable'
  }
  return 'reexec'
}

export function reexecThisServeUnderInitReaper(): ServeInitReaperOutcome {
  const execve = process.execve
  return reexecServeUnderInitReaper({
    platform: process.platform,
    pid: process.pid,
    env: process.env,
    execPath: process.execPath,
    argv: process.argv,
    exists: existsSync,
    execve: execve ? (file, args, env) => execve.call(process, file, args, env) : null,
    warn: (line) => process.stderr.write(`${line}\n`)
  })
}
