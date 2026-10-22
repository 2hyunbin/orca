import { RefreshCw } from 'lucide-react'
import { Button } from '../ui/button'
import { skillInstallResultLine } from '../skills/skill-plan-op-copy'
import {
  bundledSkillInstallNeedsAttention,
  type BundledSkillInstall
} from '@/hooks/use-bundled-skill-install'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

/** The line an Install leaves on every setup surface, with Retry when it needs attention. */
export function BundledSkillInstallStatus(props: {
  install: Pick<BundledSkillInstall, 'state' | 'retry'>
  buttonSize?: 'xs' | 'sm'
  className?: string
}): React.JSX.Element | null {
  const { state, retry } = props.install
  if (state.kind === 'idle' || state.kind === 'installing') {
    return null
  }
  if (state.kind === 'unsupported') {
    return (
      <p className={cn('text-xs leading-snug text-muted-foreground', props.className)}>
        {translate(
          'auto.components.settings.BundledSkillInstallStatus.updateServer',
          'Update Orca on the server to install its skills.'
        )}
      </p>
    )
  }
  const problem = bundledSkillInstallNeedsAttention(state)
  const message = state.kind === 'failed' ? state.message : skillInstallResultLine(state.summary)
  return (
    <div className={cn('flex flex-wrap items-start gap-2', props.className)}>
      <p
        className={cn(
          'min-w-0 flex-1 whitespace-pre-line text-xs leading-snug',
          problem ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        {message}
      </p>
      {problem ? (
        <Button type="button" variant="ghost" size={props.buttonSize ?? 'sm'} onClick={retry}>
          <RefreshCw className="size-3.5" />
          {translate('auto.components.settings.AgentSkillSetupPanel.retrySetup', 'Retry')}
        </Button>
      ) : null}
    </div>
  )
}
