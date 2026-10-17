import { formatAgentTypeLabel } from '@/lib/agent-status'
import { useState, useSyncExternalStore } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { AccountSwitchSessionTree } from './AccountSwitchSessionTree'
import {
  answerAgentAccountSwitchPrompt,
  getAgentAccountSwitchPrompt,
  subscribeAgentAccountSwitchPrompt,
  type AgentAccountSwitchPrompt
} from '@/lib/agent-account-switch-sessions'

export default function AccountSwitchSessionsDialog(): React.JSX.Element | null {
  const prompt = useSyncExternalStore(
    subscribeAgentAccountSwitchPrompt,
    getAgentAccountSwitchPrompt,
    getAgentAccountSwitchPrompt
  )
  // Why keyed: each question asks afresh, with the box unticked and every session selected.
  return prompt ? <SwitchPromptDialog key={prompt.id} prompt={prompt} /> : null
}

function dialogTitle(prompt: AgentAccountSwitchPrompt): string {
  if (prompt.reason === 'restored') {
    return translate(
      'accounts.switchSessions.restoredTitle',
      '{{agent}} is still on a previous account',
      { agent: formatAgentTypeLabel(prompt.agent) }
    )
  }
  return prompt.nextAccountLabel === null
    ? translate('accounts.switchSessions.titleUnnamed', 'Account switched')
    : translate('accounts.switchSessions.title', 'Switched to {{account}}', {
        account: prompt.nextAccountLabel
      })
}

function dialogBody(prompt: AgentAccountSwitchPrompt): string {
  const values = {
    count: prompt.sessions.length,
    previous:
      prompt.previousAccountLabel ??
      translate('accounts.switchSessions.previousAccount', 'a previous account'),
    next:
      prompt.nextAccountLabel ??
      translate('accounts.switchSessions.currentAccount', 'the current account')
  }
  const one = prompt.sessions.length === 1
  if (prompt.agent === 'claude') {
    return one
      ? translate(
          'accounts.switchSessions.claude.bodyOne',
          '1 Claude session is still running on {{previous}}. Restarting continues the conversation on {{next}}. Busy sessions wait for idle before restarting.',
          values
        )
      : translate(
          'accounts.switchSessions.claude.bodyOther',
          '{{count}} Claude sessions are still running on {{previous}}. Restarting continues each conversation on {{next}}. Busy sessions wait for idle before restarting.',
          values
        )
  }
  if (prompt.reason === 'restored') {
    return one
      ? translate(
          'accounts.switchSessions.codex.restoredBodyOne',
          '1 Codex session from your last run is still on {{previous}}. Restarting relaunches it on {{next}} and stops any work in progress.',
          values
        )
      : translate(
          'accounts.switchSessions.codex.restoredBodyOther',
          '{{count}} Codex sessions from your last run are still on {{previous}}. Restarting relaunches them on {{next}} and stops any work in progress.',
          values
        )
  }
  return one
    ? translate(
        'accounts.switchSessions.codex.bodyOne',
        '1 Codex session is still running on {{previous}}. Restarting relaunches it on {{next}} and stops any work in progress.',
        values
      )
    : translate(
        'accounts.switchSessions.codex.bodyOther',
        '{{count}} Codex sessions are still running on {{previous}}. Restarting relaunches them on {{next}} and stops any work in progress.',
        values
      )
}

function SwitchPromptDialog({ prompt }: { prompt: AgentAccountSwitchPrompt }): React.JSX.Element {
  const [dontAskAgain, setDontAskAgain] = useState(false)
  // Why unticks, not ticks: every listed session starts selected.
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set())
  const count = prompt.sessions.length
  const chosen = prompt.sessions
    .map((session) => session.ptyId)
    .filter((ptyId) => !unticked.has(ptyId))
  const toggle = (ptyId: string, checked: boolean): void => {
    setUnticked((current) => {
      const next = new Set(current)
      if (checked) {
        next.delete(ptyId)
      } else {
        next.add(ptyId)
      }
      return next
    })
  }
  // Why Keep for Codex: its restart stops work at once, so a stray Enter must not trigger it (#10863).
  const focusRestart = prompt.agent === 'claude'
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Why: closing never undoes the switch; it answers "Keep as is".
        if (!open) {
          answerAgentAccountSwitchPrompt('keep', { dontAskAgain })
        }
      }}
    >
      <DialogContent
        data-session-list={count > 1}
        className="sm:max-w-md sm:data-[session-list=true]:max-w-lg"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>{dialogTitle(prompt)}</DialogTitle>
          <DialogDescription>{dialogBody(prompt)}</DialogDescription>
        </DialogHeader>
        {count > 1 && (
          <AccountSwitchSessionTree
            agent={prompt.agent}
            sessions={prompt.sessions}
            selected={new Set(chosen)}
            onToggle={toggle}
          />
        )}
        <label className="flex min-w-0 items-start gap-2.5">
          <Checkbox
            checked={dontAskAgain}
            onCheckedChange={(checked) => setDontAskAgain(checked === true)}
            className="mt-0.5"
          />
          <span className="min-w-0 space-y-0.5">
            <span className="block text-sm">
              {translate(
                'accounts.switchSessions.dontAskAgain',
                "Don't ask again (restart automatically)"
              )}
            </span>
            <span className="block text-xs text-muted-foreground">
              {translate(
                'accounts.switchSessions.dontAskAgainHint',
                'You can turn this off in Settings → AI Provider Accounts.'
              )}
            </span>
          </span>
        </label>
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            autoFocus={!focusRestart}
            onClick={() => answerAgentAccountSwitchPrompt('keep', { dontAskAgain })}
          >
            {translate('accounts.switchSessions.keep', 'Keep as is')}
          </Button>
          <Button
            type="button"
            size="sm"
            autoFocus={focusRestart}
            disabled={chosen.length === 0}
            onClick={() =>
              answerAgentAccountSwitchPrompt('restart', { ptyIds: chosen, dontAskAgain })
            }
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {chosen.length <= 1
              ? translate('accounts.switchSessions.restartOne', 'Restart session')
              : translate('accounts.switchSessions.restartOther', 'Restart {{count}} sessions', {
                  count: chosen.length
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
