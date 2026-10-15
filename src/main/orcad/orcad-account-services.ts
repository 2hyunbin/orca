/**
 * The Claude/Codex accounts this server owns, so `accounts.*` and the launches it starts use the
 * account selected here, as desktop `orca serve` did (#28962).
 */
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { PrepareClaudeAuth } from '../ipc/pty/host-env/types'
import type { ClaudeStatusLineRateLimits } from '../../shared/claude-statusline-rate-limits'
import { createProviderAccountServices } from '../provider-account-services'
import { createCodexRuntimeHomeLaunchPreparation } from '../codex/codex-runtime-home-launch-preparation'
import { resolveHostAgentBaseEnvironment } from '../runtime/structured-agent-shell-environment'
import { isWslHostOrcadProcess } from '../ipc/wsl-guest-windows-drive-path'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'

export type OrcadAccountLaunchPreparation = {
  prepareCodexHome: ReturnType<typeof createCodexRuntimeHomeLaunchPreparation>
  prepareClaudeAuth: PrepareClaudeAuth
}

export function installOrcadAccountServices(args: {
  runtime: Pick<
    OrcaRuntimeService,
    'setAccountServices' | 'setCommitMessageAgentEnvironmentResolvers'
  >
  store: Store
  setClaudeStatusLineListener: (
    listener: ((event: ClaudeStatusLineRateLimits) => void) | null
  ) => void
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
  isWslHost?: () => boolean
}): OrcadAccountLaunchPreparation | null {
  // Why: the Windows desktop owns a WSL host's accounts and pushes them (accounts.setHostLaunchEnv),
  // which a host with services of its own refuses.
  if ((args.isWslHost ?? isWslHostOrcadProcess)()) {
    return null
  }
  const { store } = args
  const services = createProviderAccountServices(store, {
    setClaudeStatusLineListener: args.setClaudeStatusLineListener
  })
  // Why no start(): like headless desktop serve, usage refreshes on demand (accounts.list, subscribe).
  args.registerCleanup(() => {
    services.rateLimits.stop()
    args.setClaudeStatusLineListener(null)
  })
  const prepareCodexHome = createCodexRuntimeHomeLaunchPreparation({
    getRuntimeHome: () => services.codexRuntimeHome,
    getSettings: () => store.getSettings()
  })
  const prepareClaudeAuth: PrepareClaudeAuth = (target) =>
    services.claudeRuntimeAuth.prepareForClaudeLaunch(target)
  args.runtime.setAccountServices({
    claudeAccounts: services.claudeAccounts,
    codexAccounts: services.codexAccounts,
    rateLimits: services.rateLimits
  })
  args.runtime.setCommitMessageAgentEnvironmentResolvers({
    prepareForCodexLaunch: prepareCodexHome,
    prepareForClaudeLaunch: prepareClaudeAuth,
    resolveBaseEnvironment: () => resolveHostAgentBaseEnvironment(store.getSettings())
  })
  return { prepareCodexHome, prepareClaudeAuth }
}
