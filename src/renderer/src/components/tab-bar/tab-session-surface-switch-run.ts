import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { useAppStore } from '@/store'
import {
  isAiVaultSessionResumableContent,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import { formatAgentTypeLabel } from '../../../../shared/agent-type-label'
import {
  lookupTabSessionHistoryRow,
  resolveTabSessionSwitch,
  type TabSessionHistorySubject
} from './tab-session-history-switch'

// Module scope so the tab menu and the pane header share it, and a reopened menu still sees it.
const runningSwitches = new Set<string>()

/** A terminal tab or a native chat tab, by the id its menu or pane header knows it by. */
export function isTabStillOpen(tab: { id: string; worktreeId: string }): boolean {
  const state = useAppStore.getState()
  const isThisTab = (candidate: { id: string }): boolean => candidate.id === tab.id
  return (
    (state.tabsByWorktree[tab.worktreeId]?.some(isThisTab) ?? false) ||
    (state.unifiedTabsByWorktree[tab.worktreeId]?.some(isThisTab) ?? false)
  )
}

function subjectKey(subject: TabSessionHistorySubject): string {
  return subject.kind === 'chat'
    ? `chat:${subject.sessionId}`
    : `cli:${subject.agent}:${subject.providerSessionId}`
}

function notifySwitchFailed(subject: TabSessionHistorySubject, error: unknown): void {
  const description = error instanceof Error && error.message ? error.message : undefined
  toast.error(
    subject.kind === 'chat'
      ? translate(
          'auto.components.right.sidebar.AiVaultPanel.resumeInNewCliFailed',
          'Could not resume this session in a new CLI.'
        )
      : translate(
          'auto.components.right.sidebar.AiVaultPanel.resumeInChatFailed',
          'Could not resume this session in a new chat.'
        ),
    description ? { description } : undefined
  )
}

function notifySwitchRefused(subject: TabSessionHistorySubject): void {
  toast.error(
    subject.kind === 'chat'
      ? translate(
          'auto.components.right.sidebar.AiVaultPanel.resumeInNewCliUnavailable',
          'This session cannot be opened in the CLI.'
        )
      : translate(
          'components.native-chat.resumeInNewChat.cannotResume',
          "This {{agent}} conversation can't be resumed in a native chat.",
          { agent: formatAgentTypeLabel(subject.agent) }
        )
  )
}

/** A tab's "Resume in New CLI" / "Resume in New Native Chat" click: finds the tab's Session History
 *  row now, then runs the row's own move under the row's gate. `launch` is that move's handler. */
export async function runTabSessionSurfaceSwitch(args: {
  subject: TabSessionHistorySubject
  /** False once the tab the click came from has closed, which abandons the click. */
  isSourceOpen: () => boolean
  launch: (row: AiVaultSession, worktreeId: string) => Promise<void>
}): Promise<void> {
  const key = subjectKey(args.subject)
  if (runningSwitches.has(key)) {
    return
  }
  runningSwitches.add(key)
  try {
    await switchTabSession(args)
  } catch (error) {
    if (args.isSourceOpen()) {
      notifySwitchFailed(args.subject, error)
    }
  } finally {
    runningSwitches.delete(key)
  }
}

async function switchTabSession({
  subject,
  isSourceOpen,
  launch
}: Parameters<typeof runTabSessionSurfaceSwitch>[0]): Promise<void> {
  const row = await lookupTabSessionHistoryRow(
    subject,
    (listArgs) => window.api.aiVault.listSessions(listArgs),
    { requestToken: createBrowserUuid(), isCancelled: () => !isSourceOpen() }
  )
  if (!isSourceOpen()) {
    return
  }
  if (row === undefined) {
    notifySwitchFailed(subject, null)
    return
  }
  // Already resumed in a chat: open that chat, as the Session History row's Resume does.
  if (subject.kind === 'cli' && row?.structuredSession) {
    await activateAiVaultStructuredSession(row)
    return
  }
  if (!row || !isAiVaultSessionResumableContent(row)) {
    toast.error(
      translate(
        'components.native-chat.resumeInNewChat.notSavedYet',
        "{{agent}} hasn't saved this conversation yet. Try again after it replies.",
        { agent: formatAgentTypeLabel(subject.agent) }
      )
    )
    return
  }
  const move = resolveTabSessionSwitch(useAppStore.getState(), row, subject)
  if (!move) {
    notifySwitchRefused(subject)
    return
  }
  await launch(row, move.worktreeId)
}
