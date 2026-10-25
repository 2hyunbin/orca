import type * as pty from 'node-pty'
import {
  hostReportsChildExitStatus,
  wrapShellSpawnForMacosTccAttribution
} from '../../providers/macos-tcc-login-shell'
import type { WindowsShellSpawnAttempt } from '../../providers/windows-shell-fallback-chain'
import { assignHostProcessToKillOnCloseJob } from '../../windows/windows-pty-job'
import { wrapPtySpawnInTerminalScope } from '../terminal-scopes-runtime'
import {
  watchConptyStartup,
  type ConptyStartupEvents,
  type ConptyStartupOutcome
} from './conpty-startup-input-reader'

async function loadNodePty(): Promise<typeof pty> {
  return import('node-pty')
}
export type SpawnedDaemonPty = {
  process: pty.IPty
  shellPath: string
  spawnCwd: string
  startupCommandDeliveredInShellArgs?: boolean
  /** False when a wrapper owns the reported status, so no exit code may be read from it. */
  reportsChildExitStatus: boolean
  /** Windows: output and exit seen while confirming ConPTY reads input; claim before subscribing. */
  claimStartupEvents?: () => ConptyStartupEvents
}

type SpawnedNativePty = { proc: pty.IPty; claimStartupEvents?: () => ConptyStartupEvents }

export async function spawnNativeDaemonPty(args: {
  shellPath: string
  shellArgs: string[]
  spawnCwd: string
  env: Record<string, string>
  cols: number
  rows: number
  windowsFallbackAttempts: WindowsShellSpawnAttempt[]
  signal?: AbortSignal
  onMacosTccSpawnStrategy?: (strategy: 'wrapped' | 'direct') => void
}): Promise<SpawnedDaemonPty> {
  let reportsChildExitStatus = true
  const spawnOnce = async (
    shellPath: string,
    shellArgs: string[],
    cwd: string
  ): Promise<pty.IPty> => {
    args.signal?.throwIfAborted()
    const tcc = wrapShellSpawnForMacosTccAttribution(shellPath, shellArgs, args.env)
    const wrapped = wrapPtySpawnInTerminalScope(tcc.file, tcc.args, args.env)
    const nodePty = await loadNodePty()
    // Establish the host job before spawning so Windows PTYs inherit membership.
    if (process.platform === 'win32') {
      assignHostProcessToKillOnCloseJob()
    }
    const proc = nodePty.spawn(wrapped.file, wrapped.args, {
      name: args.env.TERM ?? 'xterm-256color',
      cols: args.cols,
      rows: args.rows,
      cwd,
      env: wrapped.env,
      // Bundled ConPTY provides the wrap-marker behavior xterm expects.
      ...(process.platform === 'win32' ? { useConptyDll: true } : {})
    })
    reportsChildExitStatus = hostReportsChildExitStatus(tcc.file)
    args.onMacosTccSpawnStrategy?.(tcc.file === shellPath ? 'direct' : 'wrapped')
    return proc
  }
  const spawnAt = async (
    shellPath: string,
    shellArgs: string[],
    cwd: string
  ): Promise<SpawnedNativePty> => {
    const proc = await spawnOnce(shellPath, shellArgs, cwd)
    if (process.platform !== 'win32') {
      return { proc }
    }
    const startup = await awaitConptyInputReader(proc, args.signal)
    if (startup.verdict !== 'no-input-reader') {
      return { proc, claimStartupEvents: startup.claim }
    }
    // Typed input and the startup command would be swallowed; the console host's fault is transient.
    console.warn(
      `[daemon/pty] ConPTY for "${shellPath}" started without an input reader; respawning`
    )
    startup.claim()
    proc.kill()
    const retry = await spawnOnce(shellPath, shellArgs, cwd)
    const retried = await awaitConptyInputReader(retry, args.signal)
    if (retried.verdict === 'no-input-reader') {
      console.warn(`[daemon/pty] ConPTY for "${shellPath}" again started without an input reader`)
    }
    return { proc: retry, claimStartupEvents: retried.claim }
  }

  try {
    const spawned = await spawnAt(args.shellPath, args.shellArgs, args.spawnCwd)
    return {
      process: spawned.proc,
      shellPath: args.shellPath,
      spawnCwd: args.spawnCwd,
      reportsChildExitStatus,
      ...(spawned.claimStartupEvents ? { claimStartupEvents: spawned.claimStartupEvents } : {})
    }
  } catch (primaryErr) {
    args.signal?.throwIfAborted()
    if (process.platform !== 'win32') {
      throw primaryErr
    }
    for (const attempt of args.windowsFallbackAttempts.slice(1)) {
      try {
        const spawned = await spawnAt(attempt.shellPath, attempt.shellArgs, attempt.effectiveCwd)
        const message = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
        console.warn(
          `[daemon/pty] Primary shell "${args.shellPath}" failed (${message}), fell back to "${attempt.shellPath}"`
        )
        return {
          process: spawned.proc,
          shellPath: attempt.shellPath,
          spawnCwd: attempt.effectiveCwd,
          startupCommandDeliveredInShellArgs: attempt.startupCommandDeliveredInShellArgs,
          reportsChildExitStatus,
          ...(spawned.claimStartupEvents ? { claimStartupEvents: spawned.claimStartupEvents } : {})
        }
      } catch {
        args.signal?.throwIfAborted()
      }
    }
    throw primaryErr
  }
}

async function awaitConptyInputReader(
  proc: pty.IPty,
  signal: AbortSignal | undefined
): Promise<{ verdict: ConptyStartupOutcome; claim: () => ConptyStartupEvents }> {
  const watch = watchConptyStartup(proc)
  try {
    signal?.throwIfAborted()
    const verdict = await new Promise<ConptyStartupOutcome>((resolve, reject) => {
      const onAbort = (): void => reject(signal?.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
      void watch.verdict.then((outcome) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(outcome)
      })
    })
    return { verdict, claim: watch.claim }
  } catch (error) {
    // A canceled spawn must not leave the half-started shell running.
    watch.claim()
    proc.kill()
    throw error
  }
}
