/**
 * What happens to running agent terminal sessions after the user switches that agent's account:
 * ask in a dialog, or apply the saved setting. Agent-neutral; each agent is an AccountSwitchAgent.
 */
import { toast } from 'sonner'
import { formatAgentTypeLabel } from '../../../shared/agent-type-label'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import type { AccountSwitchRunningSessions } from '../../../shared/agent-account-switch-settings'
import {
  getCodexSelectionLaneKey,
  normalizeCodexAccountSelectionTarget,
  type CodexAccountSelectionTarget
} from '../../../shared/codex-selection-lane'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { AccountSwitchAgent, AgentAccountSnapshot } from './agent-account-switch-agent'
import {
  findMovableAgentSessions,
  findQueuedAccountRestartsOnAccount
} from './agent-account-switch-discovery'

export type AccountSwitchSession = {
  ptyId: string
  worktreeId: string
  tabId: string
  leafId: string
}

export type AgentAccountSwitchPrompt = {
  /** Distinguishes one question from the next. */
  id: number
  agent: AccountSwitchAgent
  sessions: AccountSwitchSession[]
  previousAccountLabel: string
  nextAccountLabel: string
}

/** 'show-confirmation' leaves the caller's own switch confirmation to show. */
export type AgentAccountSwitchOutcome = 'show-confirmation' | 'handled'

/** Whether the pane's agent is mid-turn: a restart during a reply, permission prompt or question drops it. */
export function isAgentPaneMidTurn(
  state: AppState,
  paneKey: string,
  agent: AccountRestartAgent
): boolean {
  const entry = state.agentStatusByPaneKey[paneKey]
  return entry?.agentType === agent && entry.state !== 'done'
}

/** One question per agent, host and lane: a switch moves only that lane's sessions. */
type SlotKey = { agent: AccountRestartAgent; owner: string | null; lane: string }
type PromptSlot = { key: SlotKey; prompt: AgentAccountSwitchPrompt }

const slotId = (key: SlotKey): string => JSON.stringify([key.agent, key.owner, key.lane])

let nextPromptId = 0
const generationBySlot = new Map<string, number>()
// Why a queue: a Claude and a Codex switch can both be waiting; the dialog shows the oldest.
let slots: PromptSlot[] = []
const promptListeners = new Set<() => void>()

function setSlots(next: PromptSlot[]): void {
  slots = next
  for (const listener of promptListeners) {
    listener()
  }
}

export function getAgentAccountSwitchPrompt(): AgentAccountSwitchPrompt | null {
  return slots[0]?.prompt ?? null
}

export function subscribeAgentAccountSwitchPrompt(listener: () => void): () => void {
  promptListeners.add(listener)
  return () => promptListeners.delete(listener)
}

/**
 * Starts a switch's question in `slotKey`, dropping the open ones it `covers`. The returned
 * check is false once a newer switch in the same slot has started.
 */
function beginSlot(slotKey: SlotKey, covers: (open: SlotKey) => boolean): () => boolean {
  const id = slotId(slotKey)
  const generation = (generationBySlot.get(id) ?? 0) + 1
  generationBySlot.set(id, generation)
  if (slots.some((slot) => covers(slot.key))) {
    setSlots(slots.filter((slot) => !covers(slot.key)))
  }
  return () => generationBySlot.get(id) === generation
}

/**
 * The pane's PTY id now, or null once the pane is gone.
 *
 * Why: a reattach or reconnect moves a pane onto a new PTY while its question is open, and
 * restarting or keeping the old id would act on nothing.
 */
function resolveCurrentPtyId(session: AccountSwitchSession): string | null {
  const layouts = useAppStore.getState().terminalLayoutsByTabId
  return layouts[session.tabId]?.ptyIdsByLeafId?.[session.leafId] ?? null
}

function restartSessions(agent: AccountRestartAgent, ptyIds: readonly string[]): void {
  useAppStore.getState().queuePaneAccountRestarts([...ptyIds], agent)
}

/**
 * Answers the open dialog. Like native chat's resume prompt, "don't ask again" is one-way:
 * it turns on automatic restarts however the dialog is left. Settings is where it turns off.
 */
export function answerAgentAccountSwitchPrompt(
  answer: 'restart' | 'keep',
  options: {
    /** The sessions the user ticked; every listed session when absent. */
    ptyIds?: readonly string[]
    dontAskAgain?: boolean
  } = {}
): void {
  const [current, ...rest] = slots
  if (!current) {
    return
  }
  setSlots(rest)
  const { agent, sessions } = current.prompt
  if (answer === 'restart') {
    const chosen = options.ptyIds ? new Set(options.ptyIds) : null
    // Why filtered on the listed id: that is what the dialog's ticks name.
    const restarting = sessions
      .filter((session) => !chosen || chosen.has(session.ptyId))
      .flatMap((session) => resolveCurrentPtyId(session) ?? [])
    if (restarting.length > 0) {
      restartSessions(agent.agent, restarting)
    }
  }
  if (options.dontAskAgain) {
    void useAppStore.getState().updateSettings({ [agent.settingKey]: 'restart' })
  }
}

function showRestartingToast(agent: AccountRestartAgent, count: number, account: string): void {
  const values = { agent: formatAgentTypeLabel(agent), count, account }
  toast.success(
    count === 1
      ? translate(
          'accounts.switchSessions.restartingOne',
          'Restarting 1 {{agent}} session on {{account}}',
          values
        )
      : translate(
          'accounts.switchSessions.restartingOther',
          'Restarting {{count}} {{agent}} sessions on {{account}}',
          values
        )
  )
}

function readPolicy(agent: AccountSwitchAgent): AccountSwitchRunningSessions {
  return useAppStore.getState().settings?.[agent.settingKey] ?? 'ask'
}

const SLOT_WSL_PREFIX = 'wsl:'
// Why its own key: clearing a distro-less WSL selection moves every distro's panes at once.
const SLOT_EVERY_WSL = 'wsl:*'

/**
 * Runs after an account switch has already applied: asks, restarts, or keeps the agent's sessions
 * still on the outgoing account. 'show-confirmation' leaves the caller's own toast.
 */
export async function handleRunningAgentSessionsAfterSwitch(
  agent: AccountSwitchAgent,
  args: {
    /** Host whose roster the switch wrote. */
    owner: RuntimeClientTarget
    /** The selection slot the switch wrote. */
    target?: CodexAccountSelectionTarget | null
    before: AgentAccountSnapshot
    after: AgentAccountSnapshot
    /** Set when the switch cleared every WSL distro slot at once. */
    clearsEveryWslDistro?: boolean
  }
): Promise<AgentAccountSwitchOutcome> {
  const fromAccountId = agent.launchAccountId(args.before)
  const toAccountId = agent.launchAccountId(args.after)
  // Why: a switch between coinciding homes moves nothing.
  if (fromAccountId === toAccountId) {
    return 'show-confirmation'
  }
  const target = normalizeCodexAccountSelectionTarget(args.target)
  const clearsEveryWsl =
    args.clearsEveryWslDistro === true && target.runtime === 'wsl' && target.wslDistro === null
  const scope = { owner: args.owner, target, clearsEveryWslDistro: clearsEveryWsl }
  // Why per lane: a switch moves only its own lane's sessions, so it must not replace another
  // lane's open question; the every-distro question overlaps each distro's.
  const switchSlot: SlotKey = {
    agent: agent.agent,
    owner: args.owner.kind === 'environment' ? args.owner.environmentId : null,
    lane: clearsEveryWsl ? SLOT_EVERY_WSL : getCodexSelectionLaneKey(target)
  }
  const isCurrent = beginSlot(switchSlot, (open) => {
    if (open.agent !== switchSlot.agent || open.owner !== switchSlot.owner) {
      return false
    }
    return (
      open.lane === switchSlot.lane ||
      (switchSlot.lane.startsWith(SLOT_WSL_PREFIX) &&
        (clearsEveryWsl ? open.lane.startsWith(SLOT_WSL_PREFIX) : open.lane === SLOT_EVERY_WSL))
    )
  })
  // Why: an accepted restart relaunches on whatever is selected when it runs, so it outlives
  // switches; it drops only once its session is already on the newly selected account.
  const store = useAppStore.getState()
  for (const ptyId of findQueuedAccountRestartsOnAccount(agent, {
    ...scope,
    accountId: toAccountId
  })) {
    store.consumePendingPaneAccountRestart(ptyId)
  }
  if (readPolicy(agent) === 'keep') {
    return 'show-confirmation'
  }
  const sessions = await findMovableAgentSessions(agent, { ...scope, fromAccountId }).catch(
    (error: unknown) => {
      console.warn(`[${agent.agent}-account-switch] session scan failed:`, error)
      return []
    }
  )
  if (!isCurrent()) {
    return 'handled'
  }
  // Why re-read: the setting may change while the scan runs.
  const policy = readPolicy(agent)
  if (sessions.length === 0 || policy === 'keep') {
    return 'show-confirmation'
  }
  const nextAccountLabel = agent.accountLabel(args.after)
  if (policy === 'restart') {
    restartSessions(
      agent.agent,
      sessions.map((session) => session.ptyId)
    )
    showRestartingToast(agent.agent, sessions.length, nextAccountLabel)
    return 'handled'
  }
  const prompt: AgentAccountSwitchPrompt = {
    id: ++nextPromptId,
    agent,
    sessions,
    previousAccountLabel: agent.accountLabel(args.before),
    nextAccountLabel
  }
  setSlots([
    ...slots.filter((slot) => slotId(slot.key) !== slotId(switchSlot)),
    { key: switchSlot, prompt }
  ])
  return 'handled'
}

export function resetAgentAccountSwitchSessionsForTests(): void {
  generationBySlot.clear()
  nextPromptId = 0
  setSlots([])
}
