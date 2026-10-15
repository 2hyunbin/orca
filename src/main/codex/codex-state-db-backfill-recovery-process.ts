import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { buildWslCodexAppServerArgs } from '../codex-accounts/wsl-codex-command'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { terminateCodexProbeChild } from '../rate-limits/codex-probe-termination'
import {
  createProviderSpawnSpec,
  type ProviderCloseRequest,
  type ProviderProcessGroup
} from '../provider-process/provider-process-group'
import type { CodexAppServerSpawn } from './codex-app-server-process-tree-kill'
import { stopSupervisedChildProcess } from '../provider-process/supervised-child-process-stop'

const BACKFILL_RECOVERY_KILL_SITE = 'codex-state-db-backfill-recovery'
// Codex drains on its stdin end, as the Codex connection's root-only close asks; one value
// for the spawn spec (a gone Orca) and the stop (Orca stopping it), so they cannot drift.
const BACKFILL_RECOVERY_CLOSE_REQUEST: ProviderCloseRequest = 'stdin-end'

export type CodexBackfillRecoveryProcess = {
  child: ChildProcessHandle
  group: ProviderProcessGroup | null
}

/** Starts the read-only app-server whose presence lets Codex finish its own backfill. */
export function spawnCodexBackfillRecoveryProcess(
  codexHomePath: string,
  spawnProcess: CodexAppServerSpawn,
  resolveCommand: () => string
): CodexBackfillRecoveryProcess {
  const wslHome = process.platform === 'win32' ? parseWslUncPath(codexHomePath) : null
  if (wslHome) {
    const child = spawnProcess(
      'wsl.exe',
      buildWslCodexAppServerArgs(
        wslHome.distro,
        wslHome.linuxPath,
        CODEX_READ_ONLY_APP_SERVER_ARGS
      ),
      {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
        env: process.env
      }
    )
    return { child, group: null }
  }
  const command = resolveCommand()
  // Kept alive up to an hour; on POSIX its group stops with Orca, however Orca exits.
  const spawnSpec = createProviderSpawnSpec(
    { command, args: [...CODEX_READ_ONLY_APP_SERVER_ARGS], cwd: codexHomePath },
    withCliRuntimeOnPath(command, { ...process.env, CODEX_HOME: codexHomePath }),
    process.platform,
    { lifetime: 'session', closeRequest: BACKFILL_RECOVERY_CLOSE_REQUEST }
  )
  const child = spawnProcess(spawnSpec.program, spawnSpec.args, {
    cwd: codexHomePath,
    stdio: ['pipe', 'ignore', 'ignore', ...spawnSpec.extraStdio],
    windowsHide: true,
    env: spawnSpec.env,
    ...(spawnSpec.detached ? { detached: true } : {})
  })
  return { child, group: spawnSpec.adopt(child) }
}

export async function stopCodexBackfillRecoveryProcess(
  child: ChildProcessHandle,
  group: ProviderProcessGroup | null
): Promise<void> {
  if (group) {
    // A draining session: stdin end, then the group stop, as a Codex connection close does.
    await stopSupervisedChildProcess(child, group, {
      site: BACKFILL_RECOVERY_KILL_SITE,
      closeRequest: BACKFILL_RECOVERY_CLOSE_REQUEST
    })
    return
  }
  await terminateCodexProbeChild(child)
}
