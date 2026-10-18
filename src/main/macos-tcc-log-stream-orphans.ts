import {
  splitCommandLineArgv,
  sweepProcessIdentities,
  type ProcessIdentityRow
} from './opencode/opencode-client-sweep'
import { LOG_PREDICATE } from './macos-tcc-prompt-watch'

/** The exact argv that Orca builds before the sh wrapper spawned `log stream` directly. */
const LEGACY_LOG_STREAM_COMMAND = splitCommandLineArgv(
  ['/usr/bin/log', 'stream', '--predicate', LOG_PREDICATE, '--info', '--style', 'compact'].join(' ')
).join(' ')

/**
 * Why: older builds left this `log stream` running under launchd whenever Orca died
 * uncleanly, and those orphans outlive every later launch. A live watcher's
 * `log stream` is parented by its wrapper, so only launchd's children (ppid 1) match.
 */
export function findOrphanedTccLogStreams(rows: readonly ProcessIdentityRow[]): number[] {
  return rows
    .filter((row) => row.ppid === 1 && row.argv.join(' ') === LEGACY_LOG_STREAM_COMMAND)
    .map((row) => row.pid)
}

export async function reclaimOrphanedTccLogStreams(
  deps: {
    platform?: NodeJS.Platform
    sweep?: () => Promise<ProcessIdentityRow[]>
    kill?: (pid: number, signal: NodeJS.Signals) => void
  } = {}
): Promise<number> {
  if ((deps.platform ?? process.platform) !== 'darwin') {
    return 0
  }
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal))
  let reclaimed = 0
  for (const pid of findOrphanedTccLogStreams(await (deps.sweep ?? sweepProcessIdentities)())) {
    try {
      kill(pid, 'SIGTERM')
      reclaimed++
    } catch {
      // Already gone, or another user's process.
    }
  }
  if (reclaimed > 0) {
    console.info(`[tcc-prompt-watch] reclaimed ${reclaimed} orphaned log stream process(es)`)
  }
  return reclaimed
}
