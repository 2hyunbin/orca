import { useState } from 'react'
import { MessagesSquare } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { useAppStore } from '@/store'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { resumeAiVaultSessionInNewChat } from '../right-sidebar/ai-vault-session-resume-in-chat-launch'
import { resolveTabSessionHistorySubject } from '../tab-bar/tab-session-history-switch'
import {
  isTabStillOpen,
  runTabSessionSurfaceSwitch
} from '../tab-bar/tab-session-surface-switch-run'

function notifyResumeFailed(): void {
  toast.error(
    translate(
      'auto.components.right.sidebar.AiVaultPanel.resumeInChatFailed',
      'Could not resume this session in a new chat.'
    )
  )
}

/** The tab menu's "Resume in New Native Chat" for this pane's own conversation, run the same way. */
export function TerminalPaneResumeInChatButton({
  tabId,
  worktreeId,
  paneKey
}: {
  tabId: string
  worktreeId: string
  paneKey: string
}): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const label = translate(
    'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewNativeChat',
    'Resume in New Native Chat'
  )

  const resume = async (): Promise<void> => {
    const subject = resolveTabSessionHistorySubject(useAppStore.getState(), {
      tab: { id: tabId, worktreeId },
      paneKey
    })
    if (subject?.kind !== 'cli') {
      notifyResumeFailed()
      return
    }
    await runTabSessionSurfaceSwitch({
      subject,
      isSourceOpen: () => isTabStillOpen({ id: tabId, worktreeId }),
      launch: async (row, targetWorktreeId) => {
        if (isAgentSessionHandleProvider(row.agent)) {
          await resumeAiVaultSessionInNewChat(
            row,
            row.agent,
            targetWorktreeId,
            newAgentLaunchRequestId()
          )
        }
      }
    })
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          // Same class as split so it shares the hover/active reveal.
          className="pane-title-split-trigger"
          aria-label={label}
          disabled={pending}
          onClick={(event) => {
            event.stopPropagation()
            setPending(true)
            void resume()
              .catch(notifyResumeFailed)
              .finally(() => setPending(false))
          }}
        >
          <MessagesSquare className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
