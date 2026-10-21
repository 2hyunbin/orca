import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { SpawnDeferralReason } from '../../../../shared/host-spawn-admission'

function sleepingReasonDetail(reason: SpawnDeferralReason): string {
  switch (reason) {
    case 'paused':
      return translate(
        'auto.components.terminal.pane.TerminalSleepingPaneOverlay.pausedDetail',
        'Automatic restores are paused on the computer running this session.'
      )
    case 'live_cap':
      return translate(
        'auto.components.terminal.pane.TerminalSleepingPaneOverlay.liveCapDetail',
        'Orca has reached its limit for reopening sessions on the computer running this session.'
      )
    case 'pressure':
      return translate(
        'auto.components.terminal.pane.TerminalSleepingPaneOverlay.pressureDetail',
        'The computer running this session is under heavy load.'
      )
    case 'deadline':
      return translate(
        'auto.components.terminal.pane.TerminalSleepingPaneOverlay.deadlineDetail',
        'The computer running this session was busy reopening other terminals.'
      )
  }
}

/** A restore the host kept asleep. Clicking anywhere on the pane resumes it. */
export function TerminalSleepingPaneOverlay({
  reason,
  onResume,
  onResumeAutomaticRestores
}: {
  reason: SpawnDeferralReason
  onResume: () => void
  /** Present only when the host can clear its pause. */
  onResumeAutomaticRestores?: () => void
}): React.JSX.Element {
  return (
    <div
      className="absolute inset-0 z-40 flex cursor-pointer items-center justify-center bg-background/70 p-4"
      data-terminal-sleeping-pane={reason}
      onClick={onResume}
    >
      <div
        role="status"
        className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xs"
      >
        <div className="space-y-2">
          <div className="text-sm font-medium text-foreground">
            {translate(
              'auto.components.terminal.pane.TerminalSleepingPaneOverlay.title',
              'Resume your session'
            )}
          </div>
          <div className="text-xs text-muted-foreground">{sleepingReasonDetail(reason)}</div>
          <div className="text-xs text-muted-foreground">
            {translate(
              'auto.components.terminal.pane.TerminalSleepingPaneOverlay.savedDetail',
              'Your conversation is saved. Resume whenever you’re ready.'
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          {onResumeAutomaticRestores ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={(event) => {
                // Why: the pane-wide click would also resume this one pane.
                event.stopPropagation()
                onResumeAutomaticRestores()
              }}
            >
              {translate(
                'auto.components.terminal.pane.TerminalSleepingPaneOverlay.resumeAutomaticRestores',
                'Resume automatic restores'
              )}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            onClick={(event) => {
              // Why: the pane-wide click below would resume a second time.
              event.stopPropagation()
              onResume()
            }}
          >
            <Play />
            {translate(
              'auto.components.terminal.pane.TerminalSleepingPaneOverlay.resume',
              'Resume'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
