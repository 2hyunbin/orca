import type { GlobalSettings } from '../../shared/global-settings-types'
import { isAgentStatusHooksEnabledForAgent } from '../agent-hooks/managed-agent-hook-controls'
import {
  listGuestCodexAccountHomes,
  resolveGuestCodexAccountHome
} from '../codex-accounts/guest-codex-account-homes'
import { prepareCodexLaunchHomeHooks } from '../codex/codex-launch-home-hooks'
import { stopCodexStateDbBackfillRecoveries } from '../codex/codex-state-db-backfill-recovery'
import type { GetSelectedCodexHomePath } from '../ipc/pty/host-env/types'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

/**
 * A client that selected a managed Codex account sends its home here as the launch env's
 * CODEX_HOME. This host owns that pane's status, so it puts its hook into that home (as the
 * desktop does for its own panes) and lists the home's sessions with its own.
 */
export function orcadCodexAccountHomes(
  getSettings: () => GlobalSettings,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
) {
  // Why: a Codex launch on an account home starts its state-db backfill recovery, as on the desktop.
  registerCleanup(() => stopCodexStateDbBackfillRecoveries())
  const selectLaunchHome: GetSelectedCodexHomePath = async (_target, launchEnv, context) => {
    // Why owned homes only: CODEX_HOME comes off the wire, and a user's own one is not ours to edit.
    const home = resolveGuestCodexAccountHome(launchEnv?.CODEX_HOME)
    if (!home) {
      return null
    }
    await prepareCodexLaunchHomeHooks(
      home,
      undefined,
      () => isAgentStatusHooksEnabledForAgent(getSettings(), 'codex'),
      context?.launchesCodex === true
    )
    return home
  }
  return {
    selectLaunchHome,
    listSessionHomes: (): readonly string[] => listGuestCodexAccountHomes()
  }
}
