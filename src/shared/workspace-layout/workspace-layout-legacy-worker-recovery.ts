// An orchestration worker terminal from an older build, recovered at startup (design 2.3 transition
// "legacy worker recovery"): adopted, it no longer needs its sleeping record; proven exited, its
// pane retires as well. A pane that now shows another terminal keeps its pane.

import { omitStoredFields } from './stored-record-fields'
import { applied, setLeaf, type Applied } from './workspace-layout-command-steps'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import {
  findTerminalTab,
  retireExitedSurface,
  withWorkspace,
  type ExitedSurface
} from './workspace-layout-removal'

export type LegacyWorkerRecoveryResolution = 'adopted' | 'exited'

function withoutSleepingRecord(
  model: WorkspaceLayoutModel,
  surface: ExitedSurface
): WorkspaceLayoutModel {
  const location = findTerminalTab(model, surface.terminalTabId)
  const workspace = location ? model.workspaces[location.workspaceKey] : undefined
  const leaf = workspace?.leaves?.[surface.leafId]
  if (!location || !workspace || !leaf?.sleeping) {
    return model
  }
  const next = setLeaf(workspace, surface.leafId, omitStoredFields(leaf, ['sleeping']))
  return withWorkspace(model, location.workspaceKey, next)
}

export function recoverLegacyWorker(
  model: WorkspaceLayoutModel,
  surface: ExitedSurface,
  resolution: LegacyWorkerRecoveryResolution
): Applied {
  const retired = resolution === 'exited' ? retireExitedSurface(model, surface) : model
  return applied(withoutSleepingRecord(retired ?? model, surface))
}
