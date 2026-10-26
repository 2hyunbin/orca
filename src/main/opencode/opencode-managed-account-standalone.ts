import { findOptionOccurrence } from '../../shared/command-option-occurrence'
import { getCommandTokenPathBasename } from '../../shared/command-token-scanner'
import { MANAGED_DATA_ACCOUNT_RESUME_ENV } from '../../shared/managed-data-account-resume'
import { findOpenCodeRunCommand } from '../../shared/opencode-headless-command'
import {
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../shared/tui-agent-startup-shell'
import { managedAccountLaunchEnvironment } from '../managed-data-accounts/launch-environment'
import { getManagedDataAccountService } from '../managed-data-accounts/service'

const OPENCODE_EXECUTABLE = /^opencode2?(\.(exe|cmd))?$/i

/** Whether this launch will run under an Orca-managed OpenCode data account. */
export function launchesManagedOpenCodeAccount(env: Record<string, string> | undefined): boolean {
  if (
    env?.ORCA_DATA_ACCOUNT_PROVIDER === 'opencode' &&
    env.XDG_DATA_HOME === env.ORCA_DATA_ACCOUNT_DATA_HOME
  ) {
    return true
  }
  return Boolean(
    managedAccountLaunchEnvironment(
      getManagedDataAccountService(),
      'opencode',
      env?.[MANAGED_DATA_ACCOUNT_RESUME_ENV]
    ).XDG_DATA_HOME
  )
}

/**
 * OpenCode 2's background service binds one fixed port per machine and serves only the data dir
 * that started it, so a second account's service cannot start; a private server picks its own port.
 */
export function withOpenCodeStandaloneServer(command: string, shell: AgentStartupShell): string {
  const parsed = tokenizeStartupCommand(command, shell)
  if (!parsed.ok || findOptionOccurrence(parsed.tokens, ['--standalone', '--server'], true)) {
    return command
  }
  const { tokens, spans } = parsed
  const executable = shell === 'powershell' && tokens[0] === '&' ? 1 : 0
  if (!OPENCODE_EXECUTABLE.test(getCommandTokenPathBasename(tokens[executable] ?? ''))) {
    return command
  }
  const run = findOpenCodeRunCommand(tokens, shell)
  const next = tokens[executable + 1]
  // Other subcommands reject the root-only flag.
  const anchor = run ? run.runIndex : next === undefined || next.startsWith('-') ? executable : -1
  const span = spans[anchor]
  if (!span || span.divergesFromShell) {
    return command
  }
  return `${command.slice(0, span.end)} --standalone${command.slice(span.end)}`
}
