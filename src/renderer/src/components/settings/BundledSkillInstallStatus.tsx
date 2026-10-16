import { RefreshCw } from 'lucide-react'
import { Button } from '../ui/button'
import { OnboardingInlineCommandTerminal } from '../onboarding/OnboardingInlineCommandTerminal'
import type { BundledSkillInstall } from '@/hooks/use-bundled-skill-install'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

/**
 * What an unfinished skill install leaves behind on every install surface: the reason with a
 * Retry that stands in for Install, or the terminal an Orca server too old for the bundled
 * installer still needs.
 */
export function BundledSkillInstallStatus(props: {
  install: Pick<BundledSkillInstall, 'state' | 'retry'>
  // Delete the terminal props with the legacy terminal.
  terminalWorktreeId: string
  terminalTitle?: string
  terminalAriaLabel?: string
  terminalHeightPx?: number
  onLegacyTerminalFinished: () => void
  buttonSize?: 'xs' | 'sm'
  className?: string
}): React.JSX.Element | null {
  const { state, retry } = props.install
  if (state.kind === 'failed') {
    return (
      <div className={cn('flex flex-wrap items-start gap-2', props.className)}>
        <p className="min-w-0 flex-1 whitespace-pre-line text-xs leading-snug text-destructive">
          {state.message}
        </p>
        <Button type="button" variant="ghost" size={props.buttonSize ?? 'sm'} onClick={retry}>
          <RefreshCw className="size-3.5" />
          {translate('auto.components.settings.AgentSkillSetupPanel.retrySetup', 'Retry')}
        </Button>
      </div>
    )
  }
  if (state.kind === 'legacy-terminal') {
    return (
      <div className={cn('min-w-0 max-w-full overflow-hidden', props.className)}>
        <OnboardingInlineCommandTerminal
          worktreeId={props.terminalWorktreeId}
          command={state.command}
          title={
            props.terminalTitle ??
            translate(
              'auto.components.settings.BundledSkillInstallStatus.terminalTitle',
              'Skill setup'
            )
          }
          description={translate(
            'auto.components.settings.AgentSkillSetupPanel.runCommandDescription',
            'Press Enter to run the command.'
          )}
          ariaLabel={
            props.terminalAriaLabel ??
            translate(
              'auto.components.settings.BundledSkillInstallStatus.terminalAriaLabel',
              'Skill setup command'
            )
          }
          terminalHeightPx={props.terminalHeightPx}
          terminalTopMarginPx={8}
          descriptionPaddingClassName="px-4 py-2"
          autoScrollIntoView={false}
          onTerminalExit={props.onLegacyTerminalFinished}
          onCommandFinished={props.onLegacyTerminalFinished}
        />
      </div>
    )
  }
  return null
}
