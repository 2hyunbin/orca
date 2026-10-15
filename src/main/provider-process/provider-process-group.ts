import { PROVIDER_EXEC_GATE_SCRIPT, providerExecGate } from './provider-exec-gate'
import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { resolveProviderChildEnv, type ProviderProcessLaunch } from './provider-process-launch'
import {
  PROVIDER_GROUP_REAP_TIMEOUT_MS,
  PROVIDER_SIGTERM_GRACE_MS,
  PROVIDER_STDIN_END_GRACE_MS,
  watchProviderGroup,
  type ProviderGroupOwnerDeathStop
} from './provider-group-watchdog'
import { waitForProcessExitUntil } from './provider-process-exit-deadline'

/**
 * `session`: ending stdin is a close, so the provider is stopped after a grace.
 * `one-shot`: stdin end only completes the request; the provider runs until it exits or is stopped.
 */
export type ProviderProcessLifetime = 'session' | 'one-shot'

/**
 * How a provider's owner closes it: by ending its stdin, after which a session gets its grace (a
 * drain), or by ending stdin and sending SIGTERM at once. A gone owner gets the same request.
 */
export type ProviderCloseRequest = 'stdin-end' | 'stdin-end-and-sigterm'

export type ProviderGroupOptions = {
  lifetime?: ProviderProcessLifetime
  /** Defaults to the immediate stop; a provider that drains on its stdin end opts into 'stdin-end'. */
  closeRequest?: ProviderCloseRequest
}

/** A POSIX provider Orca spawned as the leader of its own process group. */
export type ProviderProcessGroup = {
  readonly pgid: number
  /** Resolves once the provider has exited and its group is gone (or its reap timed out), so an
   *  exit reported on it never precedes the group's last member. */
  readonly exited: Promise<boolean>
  /**
   * Ends stdin, SIGTERMs the group (at once, or after a draining session's stdin-end grace),
   * SIGKILLs what outlives the SIGTERM grace, and resolves once the group is gone or its reap
   * timed out, with whether it is gone. Joins a stop already running.
   */
  stop(closeRequest?: ProviderCloseRequest): Promise<boolean>
}

const GROUP_POLL_MS = 25

type GroupChild = Pick<
  ChildProcessHandle,
  'pid' | 'spawnfile' | 'stdin' | 'stdio' | 'kill' | 'emit' | 'listenerCount' | 'exitCode' | 'signalCode' | 'once'
>

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    // An empty group is the outcome the signal asks for.
  }
}

async function waitUntil(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS))
  }
  return true
}

function ownerDeathStop({
  lifetime = 'session',
  closeRequest = 'stdin-end-and-sigterm'
}: ProviderGroupOptions): ProviderGroupOwnerDeathStop {
  if (lifetime === 'one-shot') {
    return 'one-shot'
  }
  return closeRequest === 'stdin-end' ? 'drain' : 'stop'
}

/**
 * Registers a gated POSIX child before permitting exec; natural exit reaps its group.
 * Call in the spawn's own tick. Null without a spawned pid.
 */
export function adoptProviderProcessGroup(
  child: GroupChild,
  options: ProviderGroupOptions = {},
  command = child.spawnfile
): ProviderProcessGroup | null {
  const pgid = child.pid
  // Only a process this one spawned (spawn sets `spawnfile`), never a bare pid or a stand-in: a
  // group signal reaches every member of the group.
  if (typeof child.spawnfile !== 'string' || pgid === undefined || pgid <= 1) {
    return null
  }
  const lifetime = options.lifetime ?? 'session'
  const gate = providerExecGate(child, command)
  const release = watchProviderGroup(pgid, ownerDeathStop(options), gate.ready, gate.failed)
  let rootExited = child.exitCode !== null || child.signalCode !== null
  let terminated = false
  let stopping: Promise<boolean> | null = null
  const alive = (): boolean => groupExists(pgid)
  const gone = (): boolean => !alive()
  const reap = async (): Promise<boolean> => {
    if (alive()) {
      signalGroup(pgid, 'SIGKILL')
    }
    const reaped = await waitUntil(gone, PROVIDER_GROUP_REAP_TIMEOUT_MS)
    if (reaped) {
      release()
    }
    return reaped
  }
  let selfExitReap: Promise<boolean> | null = null
  let resolveRootExit = (): void => {}
  const rootExit = new Promise<void>((resolve) => {
    resolveRootExit = resolve
  })
  const onRootExit = (): void => {
    rootExited = true
    // A provider that leaves before any SIGTERM takes the rest of its group with it.
    if (!terminated) {
      selfExitReap ??= reap()
    }
    resolveRootExit()
  }
  if (rootExited) {
    onRootExit()
  } else {
    child.once('exit', onRootExit)
  }
  const exited = rootExit.then(async () => {
    return (await (selfExitReap ?? stopping)) ?? !groupExists(pgid)
  })
  const runStop = async (closeRequest: ProviderCloseRequest): Promise<boolean> => {
    try {
      child.stdin?.end()
    } catch {
      // A broken pipe still owes the stop.
    }
    // A one-shot's stdin end was its request, so only the SIGTERM is a stop.
    if (lifetime === 'session' && closeRequest === 'stdin-end' && !rootExited) {
      await waitForProcessExitUntil(rootExit, PROVIDER_STDIN_END_GRACE_MS)
    }
    if (selfExitReap) {
      return selfExitReap
    }
    terminated = true
    signalGroup(pgid, 'SIGTERM')
    // A one-shot's helpers die with it once it has exited; a session's keep the grace to clean up.
    await (lifetime === 'one-shot'
      ? waitForProcessExitUntil(rootExit, PROVIDER_SIGTERM_GRACE_MS)
      : waitUntil(gone, PROVIDER_SIGTERM_GRACE_MS))
    return reap()
  }
  return {
    pgid,
    exited,
    stop(closeRequest = options.closeRequest ?? 'stdin-end-and-sigterm') {
      stopping ??= runStop(closeRequest)
      return stopping
    }
  }
}

export type ProviderSpawnSpec = {
  program: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  detached: boolean
  extraStdio: [] | ['pipe']
  /** POSIX: the child leads its own group, which `adopt` hands to Orca and its watchdog. */
  supervised: boolean
  /** Call with the spawned child in the same tick; null on Windows or without a pid. */
  adopt(child: GroupChild): ProviderProcessGroup | null
}

export function createProviderSpawnSpec(
  launch: ProviderProcessLaunch,
  baseEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  options: ProviderGroupOptions = {}
): ProviderSpawnSpec {
  const env = resolveProviderChildEnv(launch, baseEnv)
  const supervised = platform !== 'win32'
  if (supervised) {
    // Headless Orca runs as Node through Electron; its providers never inherit that mode.
    delete env.ELECTRON_RUN_AS_NODE
  }
  return {
    program: supervised ? '/bin/sh' : launch.command,
    args: supervised
      ? ['-c', PROVIDER_EXEC_GATE_SCRIPT, launch.command, launch.command, ...launch.args]
      : launch.args,
    env,
    cwd: launch.cwd ?? process.cwd(),
    detached: supervised,
    extraStdio: supervised ? ['pipe'] : [],
    supervised,
    adopt: (child) => (supervised ? adoptProviderProcessGroup(child, options, launch.command) : null)
  }
}
