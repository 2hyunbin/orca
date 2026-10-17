/** What a Claude account switch does to running Claude terminal sessions, via the shared dialog. */
import { useAppStore } from '@/store'
import type { CodexAccountSelectionTarget } from '../../../shared/codex-selection-lane'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { ClaudeRateLimitAccountsState } from '../../../shared/managed-account-types'
import {
  beginAgentAccountSwitch,
  readAgentAccountSwitchPolicy,
  settleAgentAccountSwitch,
  type AgentAccountSwitchOutcome
} from './agent-account-switch-sessions'
import { getClaudeAccountLabel } from './claude-account-label'
import {
  claudeLaunchAccountId,
  findMovableClaudeSessions,
  findQueuedClaudeRestartsOnAccount
} from './claude-session-account-move'

/** A selected account row and the roster it was selected from. */
export type ClaudeAccountSnapshot = {
  state: Pick<ClaudeRateLimitAccountsState, 'accounts'>
  accountId: string | null
}

/**
 * Runs after a Claude account switch has already applied: asks, restarts, or keeps Claude
 * sessions still on the outgoing account. 'show-confirmation' leaves the caller's own toast.
 */
export async function handleRunningClaudeSessionsAfterSwitch(args: {
  owner: RuntimeClientTarget
  target: CodexAccountSelectionTarget
  before: ClaudeAccountSnapshot
  after: ClaudeAccountSnapshot
}): Promise<AgentAccountSwitchOutcome> {
  const fromAccountId = claudeLaunchAccountId(args.before.state, args.before.accountId)
  const toAccountId = claudeLaunchAccountId(args.after.state, args.after.accountId)
  // Why: a server's switch, or one between coinciding launch folders, moves nothing here.
  if (args.owner.kind !== 'local' || fromAccountId === toAccountId) {
    return 'show-confirmation'
  }
  const slotKey = 'claude:local'
  const isCurrent = beginAgentAccountSwitch(slotKey)
  // Why: an accepted restart relaunches on whatever is selected when it runs, so it outlives switches.
  const store = useAppStore.getState()
  for (const ptyId of findQueuedClaudeRestartsOnAccount({
    owner: args.owner,
    target: args.target,
    accountId: toAccountId
  })) {
    store.consumePendingPaneAccountRestart(ptyId)
  }
  if (readAgentAccountSwitchPolicy('claude') === 'keep') {
    return 'show-confirmation'
  }
  const sessions = await findMovableClaudeSessions({
    owner: args.owner,
    target: args.target,
    fromAccountId
  }).catch((error: unknown) => {
    console.warn('[claude-account-switch] session scan failed:', error)
    return []
  })
  return settleAgentAccountSwitch({
    slotKey,
    isCurrent,
    agent: 'claude',
    reason: 'switch',
    sessions,
    previousAccountLabel: getClaudeAccountLabel(args.before.state, args.before.accountId),
    nextAccountLabel: getClaudeAccountLabel(args.after.state, args.after.accountId)
  })
}
