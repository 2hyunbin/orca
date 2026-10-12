// Runs a command's start effects after its reply (design 4.1, step 2). Each pane's terminal starts
// through the runtime's own create path, under the attempt its apply began, then binds to that
// pane or leaves it `failed` with its error. Nothing here waits for the reply.

import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { isValidHostTerminalTabId } from '../../shared/terminal-tab-id'
import { findTerminalTab } from '../../shared/workspace-layout/workspace-layout-removal'
import type { PaneStartInput } from './runtime-layout-commands'
import type { PaneStart } from './runtime-pane-start-attempts'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import type { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'

export type PaneStartHost = {
  holder: RuntimeWorkspaceLayouts
  createTerminal: (selector: string, opts: TerminalCreateOptions) => Promise<unknown>
}

export function startPanes(
  host: PaneStartHost,
  hostId: ExecutionHostId,
  workspace: string,
  starts: readonly PaneStart[],
  input: PaneStartInput
): void {
  for (const start of starts) {
    if (parseExecutionHostId(hostId)?.kind === 'ssh') {
      // A saved `ssh:` partition is a host not converted yet: its panes wait for it (B2).
      host.holder.endStart(hostId, workspace, start, null)
      continue
    }
    const fail = (error: unknown): void => {
      console.warn('[workspace-layout] a pane did not start:', error)
      // The create path already ended the attempt when its spawn ran; otherwise this does.
      host.holder.endStart(hostId, workspace, start, 'failed')
    }
    const opts = startOptions(host.holder, hostId, start, input)
    if (!opts) {
      fail(new Error('terminal_pane_not_startable'))
      continue
    }
    host.createTerminal(`id:${workspace}`, opts).catch(fail)
  }
}

/** The pane's own ids and spawn inputs; null for a pane whose key a terminal cannot carry. */
function startOptions(
  holder: RuntimeWorkspaceLayouts,
  hostId: ExecutionHostId,
  start: PaneStart,
  input: PaneStartInput
): TerminalCreateOptions | null {
  const pane = parsePaneKey(start.paneKey)
  const model = holder.model(hostId)
  const terminal = pane && model ? findTerminalTab(model, pane.tabId)?.tab.terminal : undefined
  if (!pane || !terminal || !isValidHostTerminalTabId(pane.tabId)) {
    return null
  }
  const cwd = input.cwd ?? terminal.startupCwd
  return {
    tabId: pane.tabId,
    leafId: pane.leafId,
    paneStart: start,
    // No window reveal: the pane is already in the layout every view reads.
    presentation: 'background',
    ...(cwd ? { cwd } : {}),
    ...(terminal.shellOverride ? { shellOverride: terminal.shellOverride } : {}),
    ...(start.restoreSessionId ? { sessionId: start.restoreSessionId } : {}),
    ...(input.initialSize ? { initialSize: input.initialSize } : {})
  }
}
