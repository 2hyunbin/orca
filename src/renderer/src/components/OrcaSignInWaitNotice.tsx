import { toast } from 'sonner'
import { Button } from './ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '../store'

export function orcaSignInWaitingLabel(): string {
  return translate(
    'auto.components.OrcaSignInWaitNotice.waiting',
    'Waiting for sign-in in your browser'
  )
}

async function copyPendingSignInLink(): Promise<void> {
  try {
    // Why: the wait can start or end around the click, leaving no link to copy.
    const link = await window.api.orcaProfiles.pendingSignInLink()
    if (!link) {
      throw new Error('No sign-in is waiting for the browser.')
    }
    await window.api.ui.writeClipboardText(link)
    toast.success(translate('auto.components.OrcaSignInWaitNotice.copied', 'Sign-in link copied'))
  } catch (error) {
    console.warn('Could not copy the Orca sign-in link:', error)
    toast.error(
      translate('auto.components.OrcaSignInWaitNotice.copyFailed', 'Could not copy the link.')
    )
  }
}

export function CopyOrcaSignInLinkButton({
  size = 'sm'
}: {
  size?: 'sm' | 'xs'
}): React.JSX.Element {
  return (
    <Button
      type="button"
      size={size}
      variant="outline"
      onClick={() => void copyPendingSignInLink()}
    >
      {translate('auto.components.OrcaSignInWaitNotice.copyLink', 'Copy sign-in link')}
    </Button>
  )
}

/** Shown beside a Sign in button while its browser sign-in is still waiting. */
export function OrcaSignInWaitNotice({
  className,
  buttonSize = 'sm'
}: {
  className?: string
  buttonSize?: 'sm' | 'xs'
}): React.JSX.Element | null {
  const pending = useAppStore((state) => state.orcaProfileSignInPending)
  if (!pending) {
    return null
  }
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <p role="status" className="text-xs text-muted-foreground">
        {orcaSignInWaitingLabel()}
      </p>
      <CopyOrcaSignInLinkButton size={buttonSize} />
    </div>
  )
}
