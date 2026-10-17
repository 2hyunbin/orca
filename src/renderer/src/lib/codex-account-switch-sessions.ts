/**
 * Feeds Codex sessions left on an earlier account into the shared switch dialog
 * (agent-account-switch-sessions.ts): after a switch, and for panes restored
 * from the last run. One question per owner and selection lane.
 */
import { useAppStore } from '@/store'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import {
  getCodexSelectionLaneKey,
  normalizeCodexAccountSelectionTarget,
  type CodexAccountSelectionTarget
} from '../../../shared/codex-selection-lane'
import {
  beginAgentAccountSwitch,
  hasOpenAgentAccountSwitchSlot,
  settleAgentAccountSwitch,
  type AccountSwitchSession,
  type AgentAccountSwitchHooks,
  type AgentAccountSwitchOutcome
} from './agent-account-switch-sessions'
import { isForeignMachineCodexPtyId } from './codex-pane-selection-lane'
import {
  markLiveCodexSessionsForRestart,
  resolveCodexSwitchAccountLabel
} from './codex-session-restart'

/** A selected account row and the roster it was selected from. */
export type CodexAccountSnapshot = {
  accounts: readonly { id: string; email: string; workspaceLabel?: string | null }[]
  accountId: string | null | undefined
}

const LOCAL_SLOT_PREFIX = 'codex:local:'
const LOCAL_WSL_SLOT_PREFIX = `${LOCAL_SLOT_PREFIX}wsl:`
// Why its own key: clearing a distro-less WSL selection strands every distro's panes at once.
const EVERY_WSL_SLOT_KEY = `${LOCAL_WSL_SLOT_PREFIX}*`

const CODEX_HOOKS: AgentAccountSwitchHooks = {
  keep: (ptyIds) => {
    useAppStore.getState().keepCodexStalePanes(ptyIds)
    // Why: the startup sweep re-asks from main's launch record, so a kept pane must lose it.
    // Main records only this machine's spawns.
    const localPtyIds = ptyIds.filter((ptyId) => !isForeignMachineCodexPtyId(ptyId))
    if (localPtyIds.length > 0) {
      void window.api.codexAccounts.forgetStalePanes({ ptyIds: localPtyIds }).catch((error) => {
        console.warn('[codex-account-switch] failed to forget kept panes:', error)
      })
    }
  },
  isStillOwed: (ptyId) => {
    const state = useAppStore.getState()
    const stalePane = state.codexStalePaneByPtyId[ptyId]
    return (
      stalePane !== undefined &&
      !stalePane.kept &&
      state.pendingPaneAccountRestarts[ptyId] !== 'codex'
    )
  }
}

function localSlotKey(laneKey: string): string {
  return `${LOCAL_SLOT_PREFIX}${laneKey}`
}

/** The one label every listed pane shares, or null when they differ. */
function sharedLabel(
  sessions: readonly AccountSwitchSession[],
  pick: (pane: { previousAccountLabel: string; nextAccountLabel: string }) => string
): string | null {
  const stalePanes = useAppStore.getState().codexStalePaneByPtyId
  const labels = new Set(
    sessions.flatMap((session) => {
      const pane = stalePanes[session.ptyId]
      return pane ? [pick(pane)] : []
    })
  )
  return labels.size === 1 ? [...labels][0] : null
}

/**
 * Runs after a Codex account change has applied. Asks about, restarts, or keeps the
 * live Codex panes it stranded, per the saved setting.
 */
export async function handleRunningCodexSessionsAfterSwitch(args: {
  /** Host whose roster the change wrote; never inferred from focus. */
  owner: Parameters<typeof markLiveCodexSessionsForRestart>[0]['owner']
  /** The selection slot the change wrote. */
  target?: CodexAccountSelectionTarget | null
  before: CodexAccountSnapshot
  after: CodexAccountSnapshot
  /** Set when the change cleared every WSL distro slot at once. */
  clearsEveryWslDistro?: boolean
}): Promise<AgentAccountSwitchOutcome> {
  const nextAccountLabel = resolveCodexSwitchAccountLabel(args.after.accounts, args.after.accountId)
  const environmentId = runtimeTargetEnvironmentId(args.owner)
  const target = normalizeCodexAccountSelectionTarget(args.target)
  const clearsEveryWsl =
    args.clearsEveryWslDistro === true && target.runtime === 'wsl' && target.wslDistro === null
  // Why per owner and lane: a switch strands only its own lane's panes, so it must not
  // replace another lane's open question.
  const slotKey =
    environmentId !== null
      ? `codex:env:${environmentId}`
      : clearsEveryWsl
        ? EVERY_WSL_SLOT_KEY
        : localSlotKey(getCodexSelectionLaneKey(target))
  // Why the WSL overlap: the every-distro question and a single distro's list the same panes.
  const isCurrent = beginAgentAccountSwitch(
    slotKey,
    (openSlotKey) =>
      openSlotKey === slotKey ||
      (slotKey.startsWith(LOCAL_WSL_SLOT_PREFIX) &&
        (clearsEveryWsl
          ? openSlotKey.startsWith(LOCAL_WSL_SLOT_PREFIX)
          : openSlotKey === EVERY_WSL_SLOT_KEY))
  )
  // Why scanned even under Never restart: the scan keeps each pane's launch-account memory.
  const sessions = await markLiveCodexSessionsForRestart({
    owner: args.owner,
    target: args.target,
    clearsEveryWslDistro: args.clearsEveryWslDistro,
    previousAccountLabel: resolveCodexSwitchAccountLabel(
      args.before.accounts,
      args.before.accountId
    ),
    nextAccountLabel,
    // Why the ids: two accounts can share an email, so labels cannot tell A -> B -> A apart.
    previousAccountId: args.before.accountId ?? null,
    nextAccountId: args.after.accountId ?? null
  }).catch((error: unknown) => {
    console.warn('[codex-account-switch] session scan failed:', error)
    return []
  })
  return settleAgentAccountSwitch({
    slotKey,
    isCurrent,
    agent: 'codex',
    reason: 'switch',
    sessions,
    // Why the records: a pane kept through an earlier switch still runs on its launch account.
    previousAccountLabel: sharedLabel(sessions, (pane) => pane.previousAccountLabel),
    nextAccountLabel,
    hooks: CODEX_HOOKS
  })
}

/** Offers restored panes found stale, joining their lane's open question when there is one. */
export function offerRestoredCodexSessions(
  sessions: readonly (AccountSwitchSession & { laneKey: string })[]
): void {
  const byLane = new Map<string, AccountSwitchSession[]>()
  for (const { laneKey, ...session } of sessions) {
    byLane.set(laneKey, [...(byLane.get(laneKey) ?? []), session])
  }
  for (const [laneKey, laneSessions] of byLane) {
    const slotKey =
      laneKey.startsWith('wsl:') && hasOpenAgentAccountSwitchSlot(EVERY_WSL_SLOT_KEY)
        ? EVERY_WSL_SLOT_KEY
        : localSlotKey(laneKey)
    settleAgentAccountSwitch({
      slotKey,
      isCurrent: () => true,
      agent: 'codex',
      reason: 'restored',
      sessions: laneSessions,
      previousAccountLabel: sharedLabel(laneSessions, (pane) => pane.previousAccountLabel),
      nextAccountLabel: sharedLabel(laneSessions, (pane) => pane.nextAccountLabel),
      merge: true,
      hooks: CODEX_HOOKS
    })
  }
}
