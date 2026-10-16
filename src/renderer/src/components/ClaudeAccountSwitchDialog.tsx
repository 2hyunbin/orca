import { useEffect, useId, useState, useSyncExternalStore } from 'react'
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
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import {
  answerClaudeAccountSwitchPrompt,
  getClaudeAccountSwitchPrompt,
  subscribeClaudeAccountSwitchPrompt,
  type ClaudeAccountSwitchPrompt
} from '@/lib/claude-account-switch-sessions'
import { installClaudePaneAccountTracker } from '@/lib/claude-pane-account-tracker'

export default function ClaudeAccountSwitchDialog(): React.JSX.Element | null {
  // Why here: this host is mounted once for the app's lifetime, like the tracker it needs.
  useEffect(() => installClaudePaneAccountTracker(), [])
  const prompt = useSyncExternalStore(
    subscribeClaudeAccountSwitchPrompt,
    getClaudeAccountSwitchPrompt,
    getClaudeAccountSwitchPrompt
  )
  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(open) => {
        // Why: closing never undoes the switch; it answers "Keep as is".
        if (!open) {
          answerClaudeAccountSwitchPrompt('keep')
        }
      }}
    >
      {/* Why the key: each switch asks afresh, so the checkbox must not carry over. */}
      {prompt ? <ClaudeAccountSwitchDialogContent key={prompt.id} prompt={prompt} /> : null}
    </Dialog>
  )
}

function ClaudeAccountSwitchDialogContent({
  prompt
}: {
  prompt: ClaudeAccountSwitchPrompt
}): React.JSX.Element {
  const [remember, setRemember] = useState(false)
  const checkboxId = useId()
  const count = prompt.candidates.length
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
                "1 Claude session is still running on {{previous}}. Restarting continues the conversation on {{next}}. A session that's replying restarts when it finishes.",
                accounts
              )
            : translate(
                'accounts.claude.switchSessions.bodyOther',
                "{{count}} Claude sessions are still running on {{previous}}. Restarting continues each conversation on {{next}}. A session that's replying restarts when it finishes.",
                accounts
              )}
        </DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-2">
        <Checkbox
          id={checkboxId}
          checked={remember}
          onCheckedChange={(checked) => setRemember(checked === true)}
        />
        <Label htmlFor={checkboxId}>
          {translate('accounts.claude.switchSessions.remember', 'Remember my choice')}
        </Label>
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => answerClaudeAccountSwitchPrompt('keep', { remember })}
        >
          {translate('accounts.claude.switchSessions.keep', 'Keep as is')}
        </Button>
        <Button
          type="button"
          size="sm"
          autoFocus
          onClick={() => answerClaudeAccountSwitchPrompt('restart', { remember })}
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
