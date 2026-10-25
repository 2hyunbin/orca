import { translate } from '@/i18n/i18n'

export function getClaudeSubagentNavigationTitle(): string {
  return translate(
    'auto.components.settings.claudeSubagentNavigation.title',
    'Claude subagent navigation'
  )
}

export function getClaudeSubagentNavigationDescription(): string {
  return translate(
    'auto.components.settings.claudeSubagentNavigation.description',
    'Open Claude subagents from the sidebar. Adds a shortcut to Claude’s keybindings.json and loads an Orca mod in new Orca panes. Requires Claude 2.1.300+ and status hooks. Turning off removes Orca’s shortcut; shortcuts you delete stay deleted.'
  )
}
