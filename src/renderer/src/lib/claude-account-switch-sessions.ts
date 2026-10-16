/**
 * What happens to running Claude terminal sessions after the user switches
 * Claude accounts: ask in a dialog, or apply the remembered choice.
 */
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { CodexAccountSelectionTarget } from '../../../shared/codex-selection-lane'
import type { ClaudeAccountSwitchRunningSessions } from '../../../shared/claude-account-switch-settings'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { mayBeOnClaudeAccount, recordClaudePaneAccount } from './claude-pane-account-tracker'
import {
  cancelPendingClaudeSessionMoves,
  findMovableClaudeSessions,
  moveClaudeSessionsToSelectedAccount,
  type ClaudeSessionMoveCandidate
} from './claude-session-account-move'

export type ClaudeAccountSwitchPrompt = {
  /** Distinguishes one switch's question from the next. */
  id: number
  candidates: readonly ClaudeSessionMoveCandidate[]
  previousAccountId: string | null
  previousAccountLabel: string
  nextAccountId: string | null
  nextAccountLabel: string
}

/** 'none' and 'kept' leave the caller's own switch confirmation to show. */
export type ClaudeAccountSwitchOutcome = 'none' | 'kept' | 'restarted' | 'prompted' | 'superseded'

let switchGeneration = 0
let prompt: ClaudeAccountSwitchPrompt | null = null
const promptListeners = new Set<() => void>()

function setPrompt(next: ClaudeAccountSwitchPrompt | null): void {
  prompt = next
  for (const listener of promptListeners) {
    listener()
  }
}

export function getClaudeAccountSwitchPrompt(): ClaudeAccountSwitchPrompt | null {
  return prompt
}

export function subscribeClaudeAccountSwitchPrompt(listener: () => void): () => void {
  promptListeners.add(listener)
  return () => promptListeners.delete(listener)
}

function keepSessions(request: ClaudeAccountSwitchPrompt): void {
  // Why: unknown panes were counted as outgoing, so keeping them pins that answer for later switches.
  for (const candidate of request.candidates) {
    recordClaudePaneAccount(
      makePaneKey(candidate.tabId, candidate.leafId),
      request.previousAccountId
    )
  }
}

function restartSessions(request: ClaudeAccountSwitchPrompt): void {
  moveClaudeSessionsToSelectedAccount(request.candidates, request.nextAccountId)
}

/** Answers the open dialog; `remember` stores the answer as the default for later switches. */
export function answerClaudeAccountSwitchPrompt(
  answer: 'restart' | 'keep',
  options: { remember?: boolean } = {}
): void {
  const request = prompt
  if (!request) {
    return
  }
  setPrompt(null)
  if (answer === 'restart') {
    restartSessions(request)
  } else {
    keepSessions(request)
  }
  if (options.remember) {
    void useAppStore.getState().updateSettings({ claudeAccountSwitchRunningSessions: answer })
  }
}

/**
 * Runs after a Claude account switch has already applied. Finds Claude sessions
 * still on the outgoing account and asks, restarts, or keeps them per the
 * remembered choice.
 */
export async function handleRunningClaudeSessionsAfterSwitch(args: {
  owner: RuntimeClientTarget
  target: CodexAccountSelectionTarget
  previousAccountId: string | null
  previousAccountLabel: string
  nextAccountId: string | null
  nextAccountLabel: string
}): Promise<ClaudeAccountSwitchOutcome> {
  const generation = ++switchGeneration
  // Why: a newer switch replaces the old question, including restarts still waiting on a turn.
  cancelPendingClaudeSessionMoves()
  setPrompt(null)
  const found = await findMovableClaudeSessions(args).catch((error: unknown) => {
    console.warn('[claude-account-switch] session scan failed:', error)
    return []
  })
  if (generation !== switchGeneration) {
    return 'superseded'
  }
  const candidates = found.filter((candidate) =>
    mayBeOnClaudeAccount(makePaneKey(candidate.tabId, candidate.leafId), args.previousAccountId)
  )
  if (candidates.length === 0) {
    return 'none'
  }
  const request: ClaudeAccountSwitchPrompt = {
    id: generation,
    candidates,
    previousAccountId: args.previousAccountId,
    previousAccountLabel: args.previousAccountLabel,
    nextAccountId: args.nextAccountId,
    nextAccountLabel: args.nextAccountLabel
  }
  const policy: ClaudeAccountSwitchRunningSessions =
    useAppStore.getState().settings?.claudeAccountSwitchRunningSessions ?? 'ask'
  if (policy === 'keep') {
    keepSessions(request)
    return 'kept'
  }
  if (policy === 'restart') {
    restartSessions(request)
    toast.success(
      candidates.length === 1
        ? translate(
            'accounts.claude.switchSessions.restartingOne',
            'Restarting 1 Claude session on {{account}}',
            { account: args.nextAccountLabel }
          )
        : translate(
            'accounts.claude.switchSessions.restartingOther',
            'Restarting {{count}} Claude sessions on {{account}}',
            { count: candidates.length, account: args.nextAccountLabel }
          )
    )
    return 'restarted'
  }
  setPrompt(request)
  return 'prompted'
}

export function resetClaudeAccountSwitchSessionsForTests(): void {
  switchGeneration = 0
  setPrompt(null)
}
