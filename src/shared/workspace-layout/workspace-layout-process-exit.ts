// What a terminal's exit does to its pane: today's window rules, decided from facts the runtime
// holds. A proven exit retires the pane unless it is one the user needs to see fail; an unproven
// one (a negative code, attach absence) keeps the pane and only unbinds it.

import { isProvenProcessExit } from '../terminal-exit-cause'
import { omitStoredFields } from './stored-record-fields'
import { applied, leafIdsOf, setLeaf, type Applied } from './workspace-layout-command-steps'
import { updateLegacyPersistence } from './workspace-layout-legacy-persistence'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import {
  locateExitedSurface,
  retireTerminalPane,
  withWorkspace,
  type ExitedSurface
} from './workspace-layout-removal'

export type ProcessExitFacts = {
  exitCode: number
  /** The process ran on this machine, not over SSH or on a runtime server. */
  local: boolean
  /** The pane's current start attempt spawned it: not a reattach or a cold restore. */
  spawnedFresh: boolean
  inputWritten: boolean
  outputReceived: boolean
  /** Attach found no process: never proof that it exited, whatever the code. */
  attachAbsent?: boolean
}

export type ExitVerdict = 'retire' | 'keep' | 'unbind'

export function exitVerdict(facts: ProcessExitFacts, paneCount: number): ExitVerdict {
  if (facts.attachAbsent || !isProvenProcessExit(facts.exitCode)) {
    return 'unbind'
  }
  if (facts.exitCode === 0) {
    return 'retire'
  }
  if (facts.local) {
    return 'keep'
  }
  // A newborn that dies before any input keeps its error visible; a split one only if it printed nothing.
  const newborn = facts.spawnedFresh && !facts.inputWritten
  return newborn && (paneCount === 1 || !facts.outputReceived) ? 'keep' : 'retire'
}

export function applyProcessExit(
  model: WorkspaceLayoutModel,
  surface: ExitedSurface,
  facts: ProcessExitFacts
): Applied {
  const location = locateExitedSurface(model, surface)
  if (location === 'replaced') {
    return applied(model)
  }
  if (location === 'gone') {
    // A proven exit advances the revision even when its pane was already gone, as today.
    return exitVerdict(facts, 1) === 'unbind'
      ? applied(model)
      : applied(updateLegacyPersistence(model, model, [surface.worktreeId]))
  }
  const { leafId } = surface
  switch (exitVerdict(facts, leafIdsOf(location.tab).length)) {
    case 'keep':
      return applied(model, {}, {}, { [leafId]: 'exited' })
    case 'unbind': {
      const workspace = model.workspaces[location.workspaceKey]!
      const leaf = omitStoredFields(workspace.leaves?.[leafId] ?? {}, ['ptyId', 'incarnationId'])
      const next = withWorkspace(model, location.workspaceKey, setLeaf(workspace, leafId, leaf))
      return applied(updateLegacyPersistence(model, next), {}, {}, { [leafId]: null })
    }
    case 'retire': {
      const retired = retireTerminalPane(model, location, leafId)
      return applied(
        updateLegacyPersistence(model, retired, [surface.worktreeId]),
        {},
        {},
        { [leafId]: null }
      )
    }
  }
}
