/**
 * Codex's part of the shared account switch. Codex writes each rollout under its launch
 * CODEX_HOME (`<home>/sessions/...`), and a launch reads the selected account's home, so the
 * transcript path names the account a session runs on.
 */
import {
  confirmRuntimeTerminalForegroundProcess,
  type RuntimeTerminalProcessInspection
} from '@/runtime/runtime-terminal-inspection'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { CodexManagedAccount } from '../../../shared/managed-account-types'
import { isShellProcess } from '../../../shared/shell-process-detection'
import { isClientOnlyUnverifiableInspection } from '../../../shared/terminal-process-inspection'
import type { TuiAgent } from '../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'
import {
  findAccountByHomeFolder,
  normalizeAgentHomeFolder,
  transcriptHomeFolder
} from './agent-account-switch-discovery'
import type { AccountSwitchAgent } from './agent-account-switch-agent'
import { resolveCodexSwitchAccountLabel } from './codex-session-restart'
import {
  isCodexForegroundProcess,
  isCodexRestartEligiblePane
} from './codex-pane-restart-eligibility'

/** Codex's own default home, host or inside a WSL distro. */
const DEFAULT_CODEX_HOME_SUFFIX = '/.codex'

/**
 * The Codex account a session runs on, from its rollout's `<CODEX_HOME>/sessions/...` path: a
 * saved account's home, null for System default (`~/.codex` or the configured history home),
 * undefined otherwise — including Orca's retired shared home, which no account owns.
 */
export function resolveCodexSessionAccountId(
  transcriptPath: string | undefined,
  accounts: readonly CodexManagedAccount[],
  sessionSourceHome?: GlobalSettings['codexSessionSourceHome']
): string | null | undefined {
  const home = transcriptHomeFolder(transcriptPath, 'sessions')
  if (home === undefined) {
    return undefined
  }
  const account = findAccountByHomeFolder(home, accounts, (candidate) => [
    candidate.managedHomePath,
    candidate.wslLinuxHomePath
  ])
  if (account) {
    return account.id
  }
  const systemDefaultHomes = [
    sessionSourceHome?.host,
    ...Object.values(sessionSourceHome?.wsl ?? {})
  ].flatMap((folder) => (folder?.trim() ? [normalizeAgentHomeFolder(folder.trim())] : []))
  return home.endsWith(DEFAULT_CODEX_HOME_SUFFIX) || systemDefaultHomes.includes(home)
    ? null
    : undefined
}

/**
 * Whether Codex holds the pane's foreground. Why the fresh read: the cached foreground can flap to
 * the shell for a live Codex session (#11064).
 */
async function isCodexInForeground(
  ptyId: string,
  launchAgent: TuiAgent | undefined,
  inspection: RuntimeTerminalProcessInspection
): Promise<boolean> {
  if (isCodexRestartEligiblePane({ inspection, launchAgent })) {
    return true
  }
  if (
    isClientOnlyUnverifiableInspection(inspection) ||
    inspection.foregroundProcess === null ||
    !isShellProcess(inspection.foregroundProcess)
  ) {
    return false
  }
  return isCodexForegroundProcess(await confirmRuntimeTerminalForegroundProcess(ptyId))
}

export const CODEX_ACCOUNT_SWITCH_AGENT: AccountSwitchAgent = {
  agent: 'codex',
  settingKey: 'codexAccountSwitchRunningSessions',
  // Why: a Codex restart stops work at once, so a stray Enter must not trigger it (#10863).
  defaultButton: 'keep',
  waitsForIdle: false,
  // Why not: a Codex restart without a session to resume relaunches Codex bare.
  requiresResume: false,
  transcriptAccountId: (state, transcriptPath) =>
    resolveCodexSessionAccountId(
      transcriptPath,
      state.settings?.codexManagedAccounts ?? [],
      state.settings?.codexSessionSourceHome
    ),
  launchAccountId: (snapshot) => snapshot.accountId ?? null,
  accountLabel: (snapshot) =>
    resolveCodexSwitchAccountLabel(snapshot.state.accounts, snapshot.accountId),
  isInForeground: (pane, inspection) =>
    isCodexInForeground(pane.ptyId, pane.tab.launchAgent, inspection),
  copy: {
    body: (values) =>
      values.count === 1
        ? translate(
            'accounts.switchSessions.codex.bodyOne',
            '1 Codex session is still running on {{previous}}. Restarting relaunches it on {{next}} and stops any work in progress.',
            values
          )
        : translate(
            'accounts.switchSessions.codex.bodyOther',
            '{{count}} Codex sessions are still running on {{previous}}. Restarting relaunches them on {{next}} and stops any work in progress.',
            values
          ),
    settingTitle: () =>
      translate(
        'accounts.switchSessions.codex.settingTitle',
        'When you switch accounts while Codex is running'
      ),
    settingDescription: () =>
      translate(
        'accounts.switchSessions.codex.settingDescription',
        'Restarting relaunches each running Codex session on the new account.'
      )
  }
}
