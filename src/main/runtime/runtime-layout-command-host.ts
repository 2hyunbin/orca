// The views' side of the runtime (`layout.*`, `view.*`): the per-view store, and the facts and
// effects a view's layout command reaches beyond the holder.

import { markAgentLaunchesClosedByUser } from '../agent-launch/agent-launch-pane-attachment'
import { parseExecutionHostId } from '../../shared/execution-host'
import { resolveLocalProjectRuntimeForWorktreeId } from '../local-project-runtime-resolution'
import { followMovedPane } from './moved-pane-records'
import type { OrchestrationDb } from './orchestration/db'
import type {
  LayoutCommand,
  LayoutCommandReply
} from '../../shared/workspace-layout/workspace-layout-command-types'
import {
  applyClientLayoutCommand,
  type LayoutCommandHost,
  type LayoutCommandOptions
} from './runtime-layout-commands'
import { RuntimeLayoutViews } from './runtime-layout-views'
import { startPanes, type PaneStartHost } from './runtime-pane-starts'
import type { RuntimeStore } from './runtime-store-contract'
import { terminalShellOverrideRefusal } from './terminal-shell-override-host-support'

type LayoutCommandRuntime = PaneStartHost & {
  store: () => RuntimeStore | null
  orchestration: () => OrchestrationDb | null
}

export function layoutCommandsFor(runtime: LayoutCommandRuntime): {
  views: RuntimeLayoutViews
  /** A view's layout command: applied in arrival order, replied before any start. */
  apply: (command: LayoutCommand, options: LayoutCommandOptions) => LayoutCommandReply
} {
  const views = new RuntimeLayoutViews(runtime.holder, runtime.store)
  const host = layoutCommandHost(runtime, views)
  return { views, apply: (command, options) => applyClientLayoutCommand(host, command, options) }
}

function layoutCommandHost(
  runtime: LayoutCommandRuntime,
  views: RuntimeLayoutViews
): LayoutCommandHost {
  return {
    holder: runtime.holder,
    views,
    shellOverrideRefusal: (hostId, workspace, shellOverride, cwd) => {
      const host = parseExecutionHostId(hostId)
      const store = runtime.store()
      // The workspace path needs a scan, which a reply never waits for: the create path checks
      // it again before spawning and leaves the pane `failed` with the same message.
      return terminalShellOverrideRefusal({
        shellOverride,
        connectionId: host?.kind === 'ssh' ? host.targetId : null,
        platform: process.platform,
        projectRuntime: store
          ? resolveLocalProjectRuntimeForWorktreeId(store, workspace)
          : undefined,
        cwd: cwd ?? '',
        workspacePath: ''
      })
    },
    startPanes: (hostId, workspace, starts, input) =>
      startPanes(runtime, hostId, workspace, starts, input),
    closedByUser: markAgentLaunchesClosedByUser,
    paneMoved: (move) => {
      followMovedPane(move, runtime.orchestration())
      runtime.store()?.rekeyMovedTerminalLeafRecords?.(move)
    }
  }
}
