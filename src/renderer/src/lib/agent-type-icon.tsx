import type React from 'react'
import type { AgentType } from '../../../shared/agent-status-types'
import { AgentIcon } from './agent-catalog'
import { agentTypeToIconAgent } from './agent-status'
import { ProgramIcon } from './program-icon'

/** Status-row icon: known agents get their brand icon, other OSC 7501 programs a program icon. */
export function AgentTypeIcon({
  agentType,
  size = 14
}: {
  agentType: AgentType | null | undefined
  size?: number
}): React.JSX.Element {
  const iconAgent = agentTypeToIconAgent(agentType)
  if (iconAgent) {
    return <AgentIcon agent={iconAgent} size={size} />
  }
  // Why: keep "?" for not-yet-identified agents rather than a letter for "unknown".
  if (!agentType || agentType === 'unknown') {
    return <AgentIcon agent={null} size={size} />
  }
  return <ProgramIcon program={agentType} size={size} />
}
