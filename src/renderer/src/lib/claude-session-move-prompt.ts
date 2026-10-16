import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { CodexAccountSelectionTarget } from '../../../shared/codex-selection-lane'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  cancelPendingClaudeSessionMoves,
  findMovableClaudeSessions,
  moveClaudeSessionsToSelectedAccount
} from './claude-session-account-move'

const CLAUDE_SESSION_MOVE_TOAST_ID = 'claude-session-account-move'

export type ClaudeSessionMoveOffer = 'offered' | 'none' | 'superseded'

let offerGeneration = 0

/**
 * After a Claude account switch, offers one action that moves every running
 * Claude terminal session in the switched lane onto the new account.
 */
export async function offerToMoveRunningClaudeSessions(args: {
  owner: RuntimeClientTarget
  target: CodexAccountSelectionTarget
  nextAccountLabel: string
}): Promise<ClaudeSessionMoveOffer> {
  const generation = ++offerGeneration
  // Why: a newer switch answers the old question, including moves still waiting on a turn.
  cancelPendingClaudeSessionMoves()
  toast.dismiss(CLAUDE_SESSION_MOVE_TOAST_ID)
  const candidates = await findMovableClaudeSessions(args).catch((error: unknown) => {
    console.warn('[claude-account-move] session scan failed:', error)
    return []
  })
  if (generation !== offerGeneration) {
    return 'superseded'
  }
  if (candidates.length === 0) {
    return 'none'
  }
  const title =
    candidates.length === 1
      ? translate(
          'accounts.claude.moveSessions.titleOne',
          'Move 1 running Claude session to {{account}}?',
          { account: args.nextAccountLabel }
        )
      : translate(
          'accounts.claude.moveSessions.titleOther',
          'Move {{count}} running Claude sessions to {{account}}?',
          { count: candidates.length, account: args.nextAccountLabel }
        )
  toast.info(title, {
    id: CLAUDE_SESSION_MOVE_TOAST_ID,
    description: translate(
      'accounts.claude.moveSessions.description',
      'Each session restarts and resumes its conversation. A session that is still replying moves when it finishes.'
    ),
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: translate('accounts.claude.moveSessions.action', 'Move sessions'),
      onClick: () => {
        if (generation === offerGeneration) {
          moveClaudeSessionsToSelectedAccount(candidates)
        }
      }
    },
    cancel: {
      label: translate('accounts.claude.moveSessions.dismiss', 'Not now'),
      onClick: () => {}
    }
  })
  return 'offered'
}
