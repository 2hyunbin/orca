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
import {
  answerClaudeAccountSwitchPrompt,
  getClaudeAccountSwitchPrompt,
  subscribeClaudeAccountSwitchPrompt,
  type ClaudeAccountSwitchPrompt
} from '@/lib/claude-account-switch-sessions'

export default function ClaudeAccountSwitchDialog(): React.JSX.Element | null {
  const prompt = useSyncExternalStore(
    subscribeClaudeAccountSwitchPrompt,
    getClaudeAccountSwitchPrompt,
    getClaudeAccountSwitchPrompt
  )
  // Why keyed by prompt id: each switch asks afresh, and closing must read the box too.
  const [dontAskAgainFor, setDontAskAgainFor] = useState<number | null>(null)
  const dontAskAgain = prompt !== null && dontAskAgainFor === prompt.id
  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        // Why: closing never undoes the switch; it answers "Keep as is".
        if (!open) {
          answerClaudeAccountSwitchPrompt('keep', { dontAskAgain })
        }
      }}
    >
      {prompt ? (
        <ClaudeAccountSwitchDialogContent
          prompt={prompt}
          dontAskAgain={dontAskAgain}
          onDontAskAgainChange={(checked) => setDontAskAgainFor(checked ? prompt.id : null)}
        />
      ) : null}
    </Dialog>
  )
}

function ClaudeAccountSwitchDialogContent({
  prompt,
  dontAskAgain,
  onDontAskAgainChange
}: {
  prompt: ClaudeAccountSwitchPrompt
  dontAskAgain: boolean
  onDontAskAgainChange: (checked: boolean) => void
}): React.JSX.Element {
  const count = prompt.ptyIds.length
  const accounts = {
    count,
    previous: prompt.previousAccountLabel,
    next: prompt.nextAccountLabel
  }
  return (
    <DialogContent className="sm:max-w-md" showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>
          {translate('accounts.claude.switchSessions.title', 'Switched to {{account}}', {
            account: prompt.nextAccountLabel
          })}
        </DialogTitle>
        <DialogDescription>
          {count === 1
            ? translate(
                'accounts.claude.switchSessions.bodyOne',
                '1 Claude session is still running on {{previous}}. Restarting continues the conversation on {{next}}. Busy sessions wait for idle before restarting.',
                accounts
              )
            : translate(
                'accounts.claude.switchSessions.bodyOther',
                '{{count}} Claude sessions are still running on {{previous}}. Restarting continues each conversation on {{next}}. Busy sessions wait for idle before restarting.',
                accounts
              )}
        </DialogDescription>
      </DialogHeader>
      <label className="flex min-w-0 items-start gap-2.5">
        <Checkbox
          checked={dontAskAgain}
          onCheckedChange={(checked) => onDontAskAgainChange(checked === true)}
          className="mt-0.5"
        />
        <span className="min-w-0 space-y-0.5">
          <span className="block text-sm">
            {translate(
              'accounts.claude.switchSessions.dontAskAgain',
              "Don't ask again (restart automatically)"
            )}
          </span>
          <span className="block text-xs text-muted-foreground">
            {translate(
              'accounts.claude.switchSessions.dontAskAgainHint',
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
          onClick={() => answerClaudeAccountSwitchPrompt('keep', { dontAskAgain })}
        >
          {translate('accounts.claude.switchSessions.keep', 'Keep as is')}
        </Button>
        <Button
          type="button"
          size="sm"
          autoFocus
          onClick={() => answerClaudeAccountSwitchPrompt('restart', { dontAskAgain })}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {count === 1
            ? translate('accounts.claude.switchSessions.restartOne', 'Restart session')
            : translate(
                'accounts.claude.switchSessions.restartOther',
                'Restart {{count}} sessions',
                {
                  count
                }
              )}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
