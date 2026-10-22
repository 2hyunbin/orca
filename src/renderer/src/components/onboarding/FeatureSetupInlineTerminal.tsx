// COMPAT(wsl-bridge): removed when WSL runs as an orcad host.
import { useCallback } from 'react'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import {
  buildSkillCommandForRuntime,
  buildSkillSetupTerminalCommand
} from '../settings/CliSkillRuntimeSetup'
import { OnboardingInlineCommandTerminal } from './OnboardingInlineCommandTerminal'
import {
  getOnboardingFeatureSetupAgentRuntime,
  type OnboardingFeatureSetupRuntimeContext
} from './onboarding-feature-setup-runtime'
import { translate } from '@/i18n/i18n'

type FeatureSetupInlineTerminalProps = {
  command: string
  runtimeContext?: OnboardingFeatureSetupRuntimeContext
}

export function FeatureSetupInlineTerminal({
  command,
  runtimeContext
}: FeatureSetupInlineTerminalProps): React.JSX.Element {
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const setupRuntime = runtimeContext ?? activeSkillRuntime
  const agentRuntime = getOnboardingFeatureSetupAgentRuntime(setupRuntime)
  const copiedCommand = buildSkillCommandForRuntime(command, agentRuntime)
  const prepareCommandForShell = useCallback(
    (terminalCommand: string, effectiveShell: string | undefined) =>
      buildSkillSetupTerminalCommand(terminalCommand, effectiveShell, agentRuntime),
    [agentRuntime]
  )

  return (
    <OnboardingInlineCommandTerminal
      command={copiedCommand}
      prepareCommandForShell={prepareCommandForShell}
      shellOverride={setupRuntime.terminalShellOverride}
      forceHostRuntime={Boolean(setupRuntime.installDisabledReason)}
      title={translate(
        'auto.components.onboarding.FeatureSetupInlineTerminal.c767ab7061',
        'Skill setup'
      )}
      ariaLabel={translate(
        'auto.components.onboarding.FeatureSetupInlineTerminal.47fc6cc6dc',
        'Skill setup command'
      )}
      description={translate(
        'auto.components.onboarding.FeatureSetupInlineTerminal.789b59936e',
        'Press Enter to run the command and confirm npx if asked. You can also set this up later in Settings.'
      )}
      terminalHeightPx={180}
      terminalTopMarginPx={16}
      autoScrollIntoView={false}
      onTerminalExit={notifyInstalledAgentSkillsChanged}
    />
  )
}
