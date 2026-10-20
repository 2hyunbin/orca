// Layout-owner build: what main runs after a client's startPane, wake or restartPane is written.
// Every start goes through main's one restored-pane starter, so racing triggers start one terminal.

import type {
  LayoutEffects,
  LayoutCommand
} from '../../../../shared/workspace-layout/workspace-layout-command-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { RestoredPane } from './restored-pane-start'

export type LayoutPaneStartPorts = {
  /** Main's restored-pane starter: the pane's terminal, or null once main no longer holds it. */
  start: (pane: RestoredPane) => Promise<string | null>
  /** Stops a terminal through the existing stop path; false when it could not. */
  stop: (ptyId: string) => boolean
}

const STARTING_COMMANDS: ReadonlySet<LayoutCommand['type']> = new Set([
  'startPane',
  'wake',
  'restartPane'
])

/** Whether main runs this command's effects; a create or split starts through its own path. */
export function startsPanes(command: Pick<LayoutCommand, 'type'>): boolean {
  return STARTING_COMMANDS.has(command.type)
}

/**
 * Stops, then starts, each pane the command names. Never silent: the starter shows a failed start
 * on the pane, and a failed stop is logged and starts nothing. A wake keeps its records: the start resumes
 * from them and keeps them in the pane-owned form, so a host crash resumes the agent again.
 */
export function runLayoutPaneStarts(
  command: Pick<LayoutCommand, 'type' | 'workspace'>,
  effects: LayoutEffects,
  ports: LayoutPaneStartPorts
): void {
  if (!startsPanes(command)) {
    return
  }
  const unstopped = effects.stopPtyIds.filter((ptyId) => !ports.stop(ptyId))
  if (unstopped.length > 0) {
    console.warn('[layout] a restart could not stop its terminal; nothing started', unstopped)
    return
  }
  for (const paneKey of effects.startPaneKeys) {
    const parsed = parsePaneKey(paneKey)
    if (!parsed) {
      continue
    }
    const pane = { worktreeId: command.workspace, tabId: parsed.tabId, leafId: parsed.leafId }
    // The starter shows a failed start on the pane.
    void ports.start(pane).catch(() => {})
  }
}
