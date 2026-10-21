import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { AutomaticRestorePauseReason } from '@/runtime/resume-host-automatic-restores'
import type { SpawnDeferralReason } from '../../../../shared/host-spawn-admission'

function reportedPauseDetail(reason: AutomaticRestorePauseReason | null): string {
  switch (reason) {
    case 'unclean_host_death':
      return translate(
        'auto.components.terminal.pane.TerminalSleepingPaneOverlay.uncleanPauseDetail',
        'The computer running this session reported that automatic reopening was paused after Orca’s terminal service stopped unexpectedly.'
      )
    case 'pressure':
      return translate(
        'auto.components.terminal.pane.TerminalSleepingPaneOverlay.growthPauseDetail',
        'The computer running this session reported that automatic reopening was paused after rapid growth in running programs.'
      )
    case 'operator':
      return translate(
        'auto.components.terminal.pane.TerminalSleepingPaneOverlay.manualPauseDetail',
        'The computer running this session reported that automatic reopening was paused manually.'
      )
    case null:
      return translate(
        'auto.components.terminal.pane.TerminalSleepingPaneOverlay.unavailablePauseDetail',
        "The pause reason isn't available."
      )
  }
}

function sleepingReasonDetail(reason: SpawnDeferralReason): string {
  switch (reason) {
    case 'paused':
      return translate(
        'auto.components.terminal.pane.TerminalSleepingPaneOverlay.pausedDetail',
        'This session did not reopen automatically.'
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
  observedPauseReason,
  onResume,
  onResumeAutomaticRestores
}: {
  reason: SpawnDeferralReason
  observedPauseReason?: AutomaticRestorePauseReason | null
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
          {reason === 'paused' ? (
            <div className="space-y-2 text-xs text-muted-foreground">
              {/* Reserve the tallest localized explanation so settling the report never moves controls. */}
              <div className="grid">
                {([null, 'unclean_host_death', 'pressure', 'operator'] as const).map((cause) => (
                  <div
                    key={cause ?? 'unavailable'}
                    className={
                      cause === observedPauseReason
                        ? '[grid-area:1/1]'
                        : 'invisible [grid-area:1/1]'
                    }
                    aria-hidden={cause !== observedPauseReason}
                  >
                    {reportedPauseDetail(cause)}
                  </div>
                ))}
              </div>
              <div>
                {translate(
                  'auto.components.terminal.pane.TerminalSleepingPaneOverlay.resumeGuidance',
                  'Use Resume to open this session.'
                )}
              </div>
              <div
                className={onResumeAutomaticRestores ? undefined : 'invisible'}
                aria-hidden={!onResumeAutomaticRestores}
              >
                {translate(
                  'auto.components.terminal.pane.TerminalSleepingPaneOverlay.automaticResumeGuidance',
                  'Use Resume automatic restores to turn automatic reopening back on for that computer.'
                )}
              </div>
            </div>
          ) : null}
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
