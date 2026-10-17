/**
 * What happens to running Claude terminal sessions after the user switches
 * Claude accounts: ask in a dialog, or apply the saved setting.
 */
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { CodexAccountSelectionTarget } from '../../../shared/codex-selection-lane'
import type { ClaudeAccountSwitchRunningSessions } from '../../../shared/claude-account-switch-settings'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  findMovableClaudeSessions,
  findQueuedClaudeRestartsOnAccount
} from './claude-session-account-move'

export type ClaudeAccountSwitchPrompt = {
  /** Distinguishes one switch's question from the next. */
  id: number
  ptyIds: string[]
  previousAccountLabel: string
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

function queueClaudeRestarts(ptyIds: string[]): void {
  useAppStore.getState().queuePaneAccountRestarts(ptyIds, 'claude')
}

/**
 * Answers the open dialog. Like native chat's resume prompt, "don't ask again" is one-way:
 * it turns on automatic restarts however the dialog is left. Settings is where it turns off.
 */
export function answerClaudeAccountSwitchPrompt(
  answer: 'restart' | 'keep',
  options: { dontAskAgain?: boolean } = {}
): void {
  const request = prompt
  if (!request) {
    return
  }
  setPrompt(null)
  if (answer === 'restart') {
    queueClaudeRestarts(request.ptyIds)
  }
  if (options.dontAskAgain) {
    void useAppStore.getState().updateSettings({ claudeAccountSwitchRunningSessions: 'restart' })
  }
}

/**
 * Runs after a Claude account switch has already applied. Finds Claude sessions
 * still on the outgoing account and asks, restarts, or keeps them per the
 * saved setting.
 */
export async function handleRunningClaudeSessionsAfterSwitch(args: {
  owner: RuntimeClientTarget
  target: CodexAccountSelectionTarget
  previousAccountId: string | null
  nextAccountId: string | null
  previousAccountLabel: string
  nextAccountLabel: string
}): Promise<ClaudeAccountSwitchOutcome> {
  // Why first: a server's switch moves nothing here, so local questions and queued restarts stand.
  if (args.owner.kind !== 'local') {
    return 'none'
  }
  const generation = ++switchGeneration
  setPrompt(null)
  // Why: an accepted restart relaunches on whatever is selected when it runs, so it outlives
  // later switches; it drops only once its session is already on the newly selected account.
  const store = useAppStore.getState()
  for (const ptyId of findQueuedClaudeRestartsOnAccount({
    owner: args.owner,
    target: args.target,
    accountId: args.nextAccountId
  })) {
    store.consumePendingPaneAccountRestart(ptyId)
  }
  const found = await findMovableClaudeSessions({
    owner: args.owner,
    target: args.target,
    fromAccountId: args.previousAccountId
  }).catch((error: unknown) => {
    console.warn('[claude-account-switch] session scan failed:', error)
    return []
  })
  if (generation !== switchGeneration) {
    return 'superseded'
  }
  if (found.length === 0) {
    return 'none'
  }
  const request: ClaudeAccountSwitchPrompt = {
    id: generation,
    ptyIds: found.map((candidate) => candidate.ptyId),
    previousAccountLabel: args.previousAccountLabel,
    nextAccountLabel: args.nextAccountLabel
  }
  const policy: ClaudeAccountSwitchRunningSessions =
    useAppStore.getState().settings?.claudeAccountSwitchRunningSessions ?? 'ask'
  if (policy === 'keep') {
    return 'kept'
  }
  if (policy === 'restart') {
    queueClaudeRestarts(request.ptyIds)
    toast.success(
      request.ptyIds.length === 1
        ? translate(
            'accounts.claude.switchSessions.restartingOne',
            'Restarting 1 Claude session on {{account}}',
            { account: args.nextAccountLabel }
          )
        : translate(
            'accounts.claude.switchSessions.restartingOther',
            'Restarting {{count}} Claude sessions on {{account}}',
            { count: request.ptyIds.length, account: args.nextAccountLabel }
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
