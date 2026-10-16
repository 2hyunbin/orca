import { useAppStore } from '@/store'
import { ORCA_CLI_SKILL_NAME } from '@/lib/agent-feature-skill-names'
import { AgentSkillSetupPanel } from '../settings/AgentSkillSetupPanel'
import type { useMobileEmulatorAgentSetupState } from './use-mobile-emulator-agent-setup-state'
import { translate } from '@/i18n/i18n'

type MobileEmulatorAgentSetupGuideStepsProps = {
  setup: ReturnType<typeof useMobileEmulatorAgentSetupState>
  worktreeId: string
}

export function MobileEmulatorAgentSetupGuideSteps({
  setup,
  worktreeId
}: MobileEmulatorAgentSetupGuideStepsProps): React.JSX.Element {
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const terminalWorktreeId = `mobile-emulator-${worktreeId}-orca-cli-skill-terminal`

  return (
    <div className="py-2.5">
      <p className="text-sm font-medium">
        {translate(
          'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.21f5687c07',
          'Orca CLI skill'
        )}
      </p>
      <AgentSkillSetupPanel
        variant="inline"
        hideHeader
        className="min-w-0"
        title={translate(
          'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.21f5687c07',
          'Orca CLI skill'
        )}
        description={translate(
          'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.64fb057667',
          'Teaches agents the orca emulator commands for this worktree.'
        )}
        // Why no agentRuntime: detection here scans the host, so a WSL install would land unseen.
        skillNames={[ORCA_CLI_SKILL_NAME]}
        terminalTitle={translate(
          'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.5c59ea96ca',
          'Mobile emulator Orca CLI skill setup'
        )}
        terminalAriaLabel={translate(
          'auto.components.emulator.pane.MobileEmulatorAgentSetupGuideSteps.bff5341ac3',
          'Mobile emulator Orca CLI skill install terminal'
        )}
        terminalWorktreeId={terminalWorktreeId}
        installed={setup.cliSkillInstalled}
        loading={setup.cliSkillLoading || setup.setupRechecking}
        error={setup.cliSkillError}
        showInstallWhenInstalled={!setup.cliSkillInstalled}
        terminalHeightPx={112}
        onBeforeInstall={() => {
          recordFeatureInteraction('mobile-emulator-agent-setup')
        }}
        onRecheck={() => {
          recordFeatureInteraction('mobile-emulator-agent-setup')
          void setup.recheckSetup()
        }}
      />
    </div>
  )
}
