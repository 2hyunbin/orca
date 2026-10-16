import { OnboardingInlineCommandTerminal } from '../onboarding/OnboardingInlineCommandTerminal'
import { translate } from '@/i18n/i18n'

/**
 * The terminal install for an Orca server older than the bundled installer. Delete with
 * buildLegacyNpxSkillInstallCommand once servers without `skills.install.bundled-orca.v1`
 * age out.
 */
export function LegacySkillSetupTerminal(props: {
  command: string
  title: string
  ariaLabel: string
  worktreeId: string
  heightPx?: number
  onFinished: () => void
}): React.JSX.Element {
  return (
    <OnboardingInlineCommandTerminal
      worktreeId={props.worktreeId}
      command={props.command}
      title={props.title}
      description={translate(
        'auto.components.settings.AgentSkillSetupPanel.runCommandDescription',
        'Press Enter to run the command.'
      )}
      ariaLabel={props.ariaLabel}
      terminalHeightPx={props.heightPx}
      terminalTopMarginPx={8}
      descriptionPaddingClassName="px-4 py-2"
      autoScrollIntoView={false}
      onTerminalExit={props.onFinished}
      onCommandFinished={props.onFinished}
    />
  )
}
