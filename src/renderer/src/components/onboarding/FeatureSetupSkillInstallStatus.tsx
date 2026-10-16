import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { BundledSkillInstallState } from '@/hooks/use-bundled-skill-install'
import { LegacySkillSetupTerminal } from '../settings/LegacySkillSetupTerminal'
import { translate } from '@/i18n/i18n'

/** What a finished feature-setup skill install left behind: an error to retry, or the old-server terminal. */
export function FeatureSetupSkillInstallStatus(props: {
  state: BundledSkillInstallState
  terminalWorktreeId: string
  onRetry: () => void
  onLegacyTerminalFinished: () => void
}): React.JSX.Element | null {
  const { state } = props
  if (state.kind === 'failed') {
    return (
      <div className="mt-4 flex flex-wrap items-start gap-2">
        <p className="min-w-0 flex-1 whitespace-pre-line text-xs leading-snug text-destructive">
          {state.message}
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={props.onRetry}>
          <RefreshCw className="size-3.5" />
          {translate('auto.components.settings.AgentSkillSetupPanel.retrySetup', 'Retry')}
        </Button>
      </div>
    )
  }
  if (state.kind === 'legacy-terminal') {
    return (
      <div className="mt-4">
        <LegacySkillSetupTerminal
          key={state.attempt}
          command={state.command}
          title={translate(
            'auto.components.onboarding.FeatureSetupInlineTerminal.c767ab7061',
            'Skill setup'
          )}
          ariaLabel={translate(
            'auto.components.onboarding.FeatureSetupInlineTerminal.47fc6cc6dc',
            'Skill setup command'
          )}
          worktreeId={props.terminalWorktreeId}
          heightPx={180}
          onFinished={props.onLegacyTerminalFinished}
        />
      </div>
    )
  }
  return null
}
