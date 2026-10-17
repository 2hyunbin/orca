import { formatAgentTypeLabel } from '../../../shared/agent-type-label'
/**
 * What happens to running agent terminal sessions after the user switches that
 * agent's account: ask in a dialog, or apply the saved setting. Shared by
 * Claude and Codex; each agent supplies how it finds its sessions.
 */
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import type {
  AccountSwitchRunningSessions,
  AgentAccountSwitchSettings
} from '../../../shared/agent-account-switch-settings'

export type AccountSwitchSession = {
  ptyId: string
  worktreeId: string
  tabId: string
  /** Null when the pane's layout has no usable leaf for it (pre-UUID layouts). */
  leafId: string | null
}

export type AgentAccountSwitchPrompt = {
  /** Distinguishes one question from the next. */
  id: number
  agent: AccountRestartAgent
  /** 'restored': sessions that outlived an app restart on an earlier account. */
  reason: 'switch' | 'restored'
  sessions: AccountSwitchSession[]
  /** Null when the listed sessions sit on different accounts. */
  previousAccountLabel: string | null
  nextAccountLabel: string | null
}

/** What an agent adds to the shared answer path. */
export type AgentAccountSwitchHooks = {
  /** Records the sessions the user chose to leave on their account. */
  keep?: (ptyIds: string[]) => void
  /** False once a listed session no longer needs the answer (moved back, kept, or queued). */
  isStillOwed?: (ptyId: string) => boolean
}

/** 'show-confirmation' leaves the caller's own switch confirmation to show. */
export type AgentAccountSwitchOutcome = 'show-confirmation' | 'handled'

const POLICY_SETTING = {
  claude: 'claudeAccountSwitchRunningSessions',
  codex: 'codexAccountSwitchRunningSessions'
} as const satisfies Record<AccountRestartAgent, keyof AgentAccountSwitchSettings>

/** Whether the pane's agent is mid-turn; a Claude restart during a permission prompt or question drops it. */
export function isAgentPaneMidTurn(
  state: AppState,
  paneKey: string,
  agent: AccountRestartAgent
): boolean {
  const entry = state.agentStatusByPaneKey[paneKey]
  return entry?.agentType === agent && entry.state !== 'done'
}

type PromptSlot = { key: string; prompt: AgentAccountSwitchPrompt; hooks: AgentAccountSwitchHooks }

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
 * Starts a switch's question in `slotKey`, dropping the open ones it `covers` (by default
 * just its own). The returned check is false once a newer switch in the same slot has started.
 */
export function beginAgentAccountSwitch(
  slotKey: string,
  covers: (openSlotKey: string) => boolean = (openSlotKey) => openSlotKey === slotKey
): () => boolean {
  const generation = (generationBySlot.get(slotKey) ?? 0) + 1
  generationBySlot.set(slotKey, generation)
  if (slots.some((slot) => covers(slot.key))) {
    setSlots(slots.filter((slot) => !covers(slot.key)))
  }
  return () => generationBySlot.get(slotKey) === generation
}

export function hasOpenAgentAccountSwitchSlot(slotKey: string): boolean {
  return slots.some((slot) => slot.key === slotKey)
}

/**
 * The pane's PTY id now, or null once the pane is gone.
 *
 * Why: a reattach or reconnect moves a pane onto a new PTY while its question is open, and
 * restarting or keeping the old id would act on nothing.
 */
function resolveCurrentPtyId(session: AccountSwitchSession): string | null {
  const state = useAppStore.getState()
  if (session.leafId) {
    return state.terminalLayoutsByTabId[session.tabId]?.ptyIdsByLeafId?.[session.leafId] ?? null
  }
  return (state.ptyIdsByTabId[session.tabId] ?? []).includes(session.ptyId) ? session.ptyId : null
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
  const { hooks } = current
  const chosen = options.ptyIds ? new Set(options.ptyIds) : null
  const restarting: string[] = []
  const keeping: string[] = []
  for (const session of sessions) {
    const ptyId = resolveCurrentPtyId(session)
    if (!ptyId || (hooks.isStillOwed && !hooks.isStillOwed(ptyId))) {
      continue
    }
    // Why matched on the listed id: that is what the dialog's ticks name.
    const ticked = answer === 'restart' && (!chosen || chosen.has(session.ptyId))
    ;(ticked ? restarting : keeping).push(ptyId)
  }
  if (restarting.length > 0) {
    restartSessions(agent, restarting)
  }
  if (keeping.length > 0) {
    hooks.keep?.(keeping)
  }
  if (options.dontAskAgain) {
    void useAppStore.getState().updateSettings({ [POLICY_SETTING[agent]]: 'restart' })
  }
}

function showRestartingToast(
  agent: AccountRestartAgent,
  count: number,
  accountLabel: string | null
): void {
  const values = { agent: formatAgentTypeLabel(agent), count }
  toast.success(
    accountLabel === null
      ? count === 1
        ? translate(
            'accounts.switchSessions.restartingOneCurrent',
            'Restarting 1 {{agent}} session on the current account',
            values
          )
        : translate(
            'accounts.switchSessions.restartingOtherCurrent',
            'Restarting {{count}} {{agent}} sessions on the current account',
            values
          )
      : count === 1
        ? translate(
            'accounts.switchSessions.restartingOne',
            'Restarting 1 {{agent}} session on {{account}}',
            { ...values, account: accountLabel }
          )
        : translate(
            'accounts.switchSessions.restartingOther',
            'Restarting {{count}} {{agent}} sessions on {{account}}',
            { ...values, account: accountLabel }
          )
  )
}

export function readAgentAccountSwitchPolicy(
  agent: AccountRestartAgent
): AccountSwitchRunningSessions {
  return useAppStore.getState().settings?.[POLICY_SETTING[agent]] ?? 'ask'
}

/**
 * Applies the agent's saved policy to the sessions a switch left on the old account,
 * or asks. `merge` adds to the slot's open question instead of replacing it.
 */
export function settleAgentAccountSwitch(args: {
  slotKey: string
  isCurrent: () => boolean
  agent: AccountRestartAgent
  reason: AgentAccountSwitchPrompt['reason']
  sessions: readonly AccountSwitchSession[]
  previousAccountLabel: string | null
  nextAccountLabel: string | null
  merge?: boolean
  hooks?: AgentAccountSwitchHooks
}): AgentAccountSwitchOutcome {
  const hooks = args.hooks ?? {}
  if (!args.isCurrent()) {
    return 'handled'
  }
  if (args.sessions.length === 0) {
    return 'show-confirmation'
  }
  // Why read here: the setting may change while the caller's scan runs.
  const policy = readAgentAccountSwitchPolicy(args.agent)
  const ptyIds = args.sessions.map((session) => session.ptyId)
  if (policy === 'keep') {
    hooks.keep?.(ptyIds)
    return 'show-confirmation'
  }
  if (policy === 'restart') {
    restartSessions(args.agent, ptyIds)
    showRestartingToast(args.agent, ptyIds.length, args.nextAccountLabel)
    return 'handled'
  }
  const open = args.merge ? slots.find((slot) => slot.key === args.slotKey) : undefined
  if (open) {
    const known = new Set(open.prompt.sessions.map((session) => session.ptyId))
    const merged: AgentAccountSwitchPrompt = {
      ...open.prompt,
      sessions: [
        ...open.prompt.sessions,
        ...args.sessions.filter((session) => !known.has(session.ptyId))
      ],
      previousAccountLabel:
        open.prompt.previousAccountLabel === args.previousAccountLabel
          ? args.previousAccountLabel
          : null,
      nextAccountLabel:
        open.prompt.nextAccountLabel === args.nextAccountLabel ? args.nextAccountLabel : null
    }
    // Why the same id: the open dialog keeps the user's unticks and checkbox state.
    setSlots(slots.map((slot) => (slot === open ? { ...slot, prompt: merged } : slot)))
    return 'handled'
  }
  const prompt: AgentAccountSwitchPrompt = {
    id: ++nextPromptId,
    agent: args.agent,
    reason: args.reason,
    sessions: [...args.sessions],
    previousAccountLabel: args.previousAccountLabel,
    nextAccountLabel: args.nextAccountLabel
  }
  setSlots([
    ...slots.filter((slot) => slot.key !== args.slotKey),
    { key: args.slotKey, prompt, hooks }
  ])
  return 'handled'
}

export function resetAgentAccountSwitchSessionsForTests(): void {
  generationBySlot.clear()
  nextPromptId = 0
  setSlots([])
}
