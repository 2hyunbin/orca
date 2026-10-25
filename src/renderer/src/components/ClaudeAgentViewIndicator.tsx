import { Eye } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { DashboardAgentRow } from './dashboard/useDashboardData'
import { useClaudeAgentRowView } from './dashboard/use-claude-agent-row-view'
import { getAgentRowPrimaryText } from '../../../shared/agent-row-primary-text'

export function ClaudeAgentViewIndicator({
  view,
  showChild = true,
  showName = false
}: {
  view: { current: boolean; agentId?: string; child: boolean; label?: string } | null
  showChild?: boolean
  showName?: boolean
}) {
  if (!view || (!view.current && (view.child || !showChild))) {
    return null
  }
  const label = view.current
    ? translate('auto.components.ClaudeAgentViewIndicator.viewing', 'Currently viewing')
    : translate(
        'auto.components.ClaudeAgentViewIndicator.viewingChild',
        'Viewing subagent {{name}}',
        { name: view.label }
      )
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-3xs text-foreground"
      title={label}
      aria-label={label}
    >
      <Eye className="size-3" aria-hidden="true" />
      {(!view.current || showName) && <span className="max-w-24 truncate">{view.label}</span>}
    </span>
  )
}

export function ClaudeAgentSummaryViewIndicator({ agent }: { agent: DashboardAgentRow }) {
  const view = useClaudeAgentRowView(agent)
  return (
    <ClaudeAgentViewIndicator
      showName
      view={
        view?.current ? { ...view, label: getAgentRowPrimaryText(agent.entry) || 'Claude' } : view
      }
    />
  )
}
