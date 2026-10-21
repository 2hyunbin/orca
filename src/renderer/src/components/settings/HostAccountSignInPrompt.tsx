import { useId, useState, useSyncExternalStore } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useClipboardTextCopyFeedback } from '@/hooks/use-clipboard-text-copy-feedback'
import {
  readHostAccountSignIn,
  submitHostAccountSignInCode,
  subscribeHostAccountSignIns
} from '@/runtime/runtime-host-account-sign-in-client'
import {
  isHostAccountSignInPage,
  type HostAccountSignInProvider
} from '../../../../shared/host-account-sign-in-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

/** A Cancel the server could not be told about yet; the sign-in keeps asking it to stop. */
export function showHostCancelFailure(error: unknown): void {
  toast.error(
    translate('accounts.hostSignIn.cancelFailed', 'Could not reach the server to cancel yet.'),
    {
      description: error instanceof Error ? error.message : String(error)
    }
  )
}

function CopyButton(props: { text: string; label: string }): React.JSX.Element {
  const { copyText, status } = useClipboardTextCopyFeedback(props.text)
  return (
    <Button variant="outline" size="xs" onClick={() => void copyText()}>
      {status === 'copied' ? <Check /> : <Copy />}
      {status === 'copied'
        ? translate('accounts.hostSignIn.copied', 'Copied')
        : status === 'failed'
          ? translate('accounts.hostSignIn.copyFailed', 'Could not copy')
          : props.label}
    </Button>
  )
}

function PastedCodeForm(props: {
  owner: RuntimeClientTarget
  provider: HostAccountSignInProvider
}): React.JSX.Element {
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const helpId = useId()
  const trimmed = code.trim()
  return (
    <form
      className="space-y-1"
      onSubmit={(event) => {
        event.preventDefault()
        if (!trimmed || pending) {
          return
        }
        setPending(true)
        void submitHostAccountSignInCode(props.owner, props.provider, trimmed)
          .catch((error: unknown) =>
            setRefusal(error instanceof Error ? error.message : String(error))
          )
          .finally(() => setPending(false))
      }}
    >
      <p id={helpId} className="text-xs text-muted-foreground">
        {translate(
          'accounts.hostSignIn.pasteCodeHelp',
          'After you sign in, the page shows a code. Paste it here.'
        )}
      </p>
      <div className="flex items-center gap-2">
        <Input
          autoComplete="off"
          spellCheck={false}
          maxLength={4_096}
          aria-labelledby={helpId}
          aria-invalid={refusal !== null}
          value={code}
          disabled={pending}
          onChange={(event) => {
            setCode(event.target.value)
            setRefusal(null)
          }}
        />
        <Button type="submit" size="sm" variant="outline" disabled={pending || !trimmed}>
          {translate('accounts.hostSignIn.continue', 'Continue')}
        </Button>
      </div>
      {refusal !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {refusal}
        </p>
      ) : null}
    </form>
  )
}

/** The page and code of an account sign-in a server runs for this client, while it runs. */
export function HostAccountSignInPrompt(props: {
  owner: RuntimeClientTarget
  provider: HostAccountSignInProvider
  hostLabel: string
}): React.JSX.Element | null {
  const read = () => readHostAccountSignIn(props.owner, props.provider)
  const status = useSyncExternalStore(subscribeHostAccountSignIns, read, read)
  if (!status) {
    return null
  }
  const prompt = status.phase === 'waiting' ? status.prompt : undefined
  const url = prompt && isHostAccountSignInPage(props.provider, prompt.url) ? prompt.url : null
  return (
    <div className="space-y-2 rounded-md border border-border/70 bg-muted/30 px-3 py-2">
      <p role="status" className="text-xs text-muted-foreground">
        {status.phase === 'starting'
          ? translate('accounts.hostSignIn.starting', 'Starting sign-in on {{host}}…', {
              host: props.hostLabel
            })
          : status.phase === 'verifying'
            ? translate('accounts.hostSignIn.verifying', 'Finishing sign-in on {{host}}…', {
                host: props.hostLabel
              })
            : translate(
                'accounts.hostSignIn.waiting',
                'Open this page on this device and sign in. The account is saved on {{host}}.',
                { host: props.hostLabel }
              )}
      </p>
      {url ? (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-1 font-mono text-[11px] text-foreground/80">
            {url}
          </span>
          <CopyButton text={url} label={translate('accounts.hostSignIn.copyLink', 'Copy link')} />
          <Button variant="ghost" size="xs" onClick={() => void window.api.shell.openUrl(url)}>
            <ExternalLink />
            {translate('accounts.hostSignIn.open', 'Open')}
          </Button>
        </div>
      ) : null}
      {url && prompt?.userCode ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {translate('accounts.hostSignIn.enterCode', 'Enter this code on that page:')}
          </span>
          <span className="rounded bg-muted px-1.5 py-1 font-mono text-xs text-foreground">
            {prompt.userCode}
          </span>
          <CopyButton
            text={prompt.userCode}
            label={translate('accounts.hostSignIn.copyCode', 'Copy code')}
          />
        </div>
      ) : null}
      {url && prompt?.needsCode ? (
        <PastedCodeForm owner={props.owner} provider={props.provider} />
      ) : null}
    </div>
  )
}
