import { pickSourceControlLaunchAgent } from '../../../../../../shared/source-control-launch-agent-selection'
import type { GitConflictOperation } from '../../../../../../shared/git-status-types'
import type { TuiAgent } from '../../../../../../shared/tui-agent'

export function shouldRenderCommitArea(
  unresolvedConflictCount: number,
  conflictOperation: GitConflictOperation
): boolean {
  return unresolvedConflictCount === 0 && conflictOperation === 'unknown'
}

export function pickDefaultSourceControlAgent(
  defaultAgent: TuiAgent | 'blank' | null | undefined,
  detectedAgents: TuiAgent[],
  disabledAgents?: TuiAgent[],
  chosenOpensAsChat?: (agent: TuiAgent) => boolean
): TuiAgent | null {
  return pickSourceControlLaunchAgent({
    defaultAgent,
    detectedAgents,
    disabledAgents,
    ...(chosenOpensAsChat ? { chosenOpensAsChat } : {})
  })
}
