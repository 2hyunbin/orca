import { Switch, Text, View } from 'react-native'
import { AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY } from '../../../src/shared/automation-runtime-capabilities'
import { AutomationChoice, AutomationField } from './AutomationControls'
import type { AutomationDraft } from './automation-draft'
import { automationStyles as styles } from './automation-styles'

export function AutomationAdvancedFields({
  draft,
  change,
  disabled,
  capabilities
}: {
  draft: AutomationDraft
  change: (patch: Partial<AutomationDraft>) => void
  disabled: boolean
  capabilities: readonly string[]
}) {
  return (
    <View style={styles.stack}>
      {draft.workspaceMode === 'new_per_run' ? (
        <AutomationField
          label="Base branch (optional)"
          value={draft.baseBranch}
          onChange={(baseBranch) => change({ baseBranch })}
          disabled={disabled}
        />
      ) : null}
      <AutomationChoice
        label="Workspace setup script"
        value={draft.setupDecision}
        options={[
          { value: 'inherit', label: 'Use project settings' },
          { value: 'run', label: 'Run setup script' },
          { value: 'skip', label: 'Skip setup script' }
        ]}
        onSelect={(setupDecision) => change({ setupDecision })}
        disabled={disabled}
      />
      {draft.workspaceMode === 'existing' ? (
        <View style={styles.row}>
          <Text style={[styles.text, styles.grow]}>Reuse agent session</Text>
          <Switch
            accessibilityLabel="Reuse agent session"
            value={draft.reuseSession}
            onValueChange={(reuseSession) => change({ reuseSession })}
            disabled={disabled}
          />
        </View>
      ) : null}
      <AutomationField
        label="Extra agent arguments"
        value={draft.extraAgentArgs}
        onChange={(extraAgentArgs) => change({ extraAgentArgs })}
        disabled={
          disabled || !capabilities.includes(AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY)
        }
      />
      <AutomationField
        label="Precheck command (optional)"
        value={draft.precheckCommand}
        onChange={(precheckCommand) => change({ precheckCommand })}
        disabled={disabled}
      />
      {draft.precheckCommand ? (
        <AutomationField
          label="Precheck timeout (seconds)"
          value={draft.precheckTimeout}
          onChange={(precheckTimeout) => change({ precheckTimeout })}
          numeric
          disabled={disabled}
        />
      ) : null}
      <AutomationField
        label="Missed-run grace (minutes)"
        value={draft.grace}
        onChange={(grace) => change({ grace })}
        numeric
        disabled={disabled}
      />
    </View>
  )
}
