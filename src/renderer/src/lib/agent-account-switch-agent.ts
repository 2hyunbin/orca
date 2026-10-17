/**
 * What one agent supplies to the shared account-switch flow. Adding an agent means writing one
 * of these and listing it in agent-account-switch-agents.ts; discovery, the question queue, the
 * dialog and the restart executor read nothing else agent-specific.
 */
import type { AppState } from '@/store'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import type { AgentAccountSwitchSettings } from '../../../shared/agent-account-switch-settings'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'

/** A selected account row and the roster it was selected from. */
export type AgentAccountSnapshot = {
  state: {
    accounts: readonly {
      id: string
      email: string
      workspaceLabel?: string | null
      runsOnSystemDefault?: boolean
    }[]
  }
  accountId: string | null | undefined
}

export type AccountSwitchAgent = {
  agent: AccountRestartAgent
  settingKey: keyof AgentAccountSwitchSettings
  /** Which answer Enter gives; 'keep' where a restart stops work at once. */
  defaultButton: 'keep' | 'restart'
  /** Whether a queued restart waits for the session's turn to end. */
  waitsForIdle: boolean
  /** Only sessions a restart can resume count; otherwise a bare relaunch is acceptable. */
  requiresResume: boolean
  /** Account id, null for System default, undefined when the transcript cannot tell. */
  transcriptAccountId: (
    state: AppState,
    transcriptPath: string | undefined
  ) => string | null | undefined
  /** The account id a session launched under `snapshot` reports in its transcript. */
  launchAccountId: (snapshot: AgentAccountSnapshot) => string | null
  accountLabel: (snapshot: AgentAccountSnapshot) => string
  isInForeground: (
    pane: { ptyId: string; tab: TerminalTab },
    inspection: RuntimeTerminalProcessInspection
  ) => Promise<boolean>
  copy: {
    /** `previous`, `next` and `count` are interpolated. */
    body: (values: { count: number; previous: string; next: string }) => string
    settingTitle: () => string
    settingDescription: () => string
  }
}
