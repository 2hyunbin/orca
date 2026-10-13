import { codexHookService } from './hook-service'
import type { CodexWslRuntimeHookTarget } from './codex-wsl-hook-install-plan'

/**
 * Puts Orca's status hook into (or, with hooks off, takes it out of) the CODEX_HOME a pane is
 * about to launch on. Best-effort: a malformed hooks file must not block Codex from starting.
 */
export async function prepareCodexLaunchHomeHooks(
  homePath: string | null,
  target: CodexWslRuntimeHookTarget | undefined,
  isHooksEnabled: () => boolean,
  launchesCodex: boolean
): Promise<void> {
  const hooksEnabled = isHooksEnabled()
  const failure = `[codex-hook-service] failed to ${hooksEnabled ? 'refresh' : 'refresh user'} runtime hooks before launch`
  try {
    // Why: honor the persisted off switch so post-startup launches can't reinstall removed hooks.
    const status = await codexHookService.prepareRuntimeHomeForLaunch(
      homePath,
      target,
      isHooksEnabled,
      launchesCodex
    )
    if (status.state === 'error') {
      console.warn(failure, status.detail)
    }
  } catch (error) {
    console.warn(failure, error)
  }
}
