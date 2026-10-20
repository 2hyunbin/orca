import React from 'react'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import {
  useNewTabAgentMenuRows,
  type AgentMenuRowsTarget
} from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import AgentCombobox from './AgentCombobox'
import type { AgentComboboxSurfaceRows } from './agent-combobox-surface-items'

// Distributes over the picker's Blank Terminal union so each arm keeps its own onValueChange.
type WithoutSurfaceRows<T> = T extends unknown ? Omit<T, 'surfaceRows'> : never

type AgentSurfaceComboboxProps = WithoutSurfaceRows<React.ComponentProps<typeof AgentCombobox>> & {
  rowsTarget: AgentMenuRowsTarget
  detectionTarget: AgentDetectionTarget | undefined
  surface?: AgentComboboxSurfaceRows['surface']
  onPick: AgentComboboxSurfaceRows['onPick']
}

/** The agent picker with the "+" menu's rows for the workspace the launch will run in. */
export default function AgentSurfaceCombobox({
  rowsTarget,
  detectionTarget,
  surface,
  onPick,
  ...props
}: AgentSurfaceComboboxProps): React.JSX.Element {
  // Why open: a mounted picker belongs to an open dialog, which holds the host's answers.
  const model = useNewTabAgentMenuRows(rowsTarget, true, detectionTarget)
  return <AgentCombobox {...props} surfaceRows={{ model, surface, onPick }} />
}
