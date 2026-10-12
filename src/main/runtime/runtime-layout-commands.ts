// A view's layout command (`layout.*`, design 2.1). The holder applies it in arrival order; this
// adds what only the runtime knows: the in-memory catalog, refusals from host facts, the drafts
// views report, what a user's close or move does beyond the layout, the starts, and the sender's
// navigation. Every command republishes its workspace, applied or not, so a view's local gesture
// drawing is always replaced by the next frame.

import { findTerminal } from '../../shared/workspace-layout/workspace-layout-command-steps'
import type {
  LayoutCommand,
  LayoutCommandReply
} from '../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayoutModel } from '../../shared/workspace-layout/workspace-layout-model'
import type { LayoutNavigateRequest } from '../../shared/workspace-layout/workspace-layout-stream-frames'
import type { LayoutViewId } from '../../shared/workspace-layout/workspace-layout-views'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { TerminalLeafMoveRequest } from '../../shared/terminal-leaf-move'
import type { TerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'
import type { PaneStart } from './runtime-pane-start-attempts'
import type { RuntimeLayoutViews } from './runtime-layout-views'
import type { HolderApplied, RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'

/** What a start needs beyond the pane: the size the sender measured and a split's cwd. */
export type PaneStartInput = { initialSize?: { cols: number; rows: number }; cwd?: string }

export type LayoutCommandOptions = PaneStartInput & {
  /** Also show the result in the sender's view, through a `navigate` frame. */
  select?: boolean
  /** The sender's view; CLI and orchestration have none. */
  viewId: LayoutViewId | null
}

export type LayoutCommandHost = {
  holder: RuntimeWorkspaceLayouts
  views: RuntimeLayoutViews
  /** Today's synchronous shell check; a refused create adds nothing. */
  shellOverrideRefusal: (
    hostId: ExecutionHostId,
    workspace: string,
    shellOverride: string,
    cwd: string | undefined
  ) => Error | null
  startPanes: (
    hostId: ExecutionHostId,
    workspace: string,
    starts: readonly PaneStart[],
    input: PaneStartInput
  ) => void
  /** A launch still starting or delivering in what the user closed stops, and says so. */
  closedByUser: (workspace: string, target: TerminalSurfaceCloseTarget) => void
  /** Agent status, orchestration and pane-keyed profile records follow a moved pane. */
  paneMoved: (move: TerminalLeafMoveRequest) => void
}

export function applyClientLayoutCommand(
  host: LayoutCommandHost,
  command: LayoutCommand,
  options: LayoutCommandOptions
): LayoutCommandReply {
  const { holder, views } = host
  const { workspace } = command
  // The in-memory catalog only: an unknown workspace is refused, never scanned for.
  const hostId = holder.published(workspace) ? holder.hostIdOf(workspace) : null
  const before = hostId ? holder.model(hostId) : null
  if (!hostId || !before) {
    return { ok: false, code: 'workspace_not_found' }
  }
  if (command.type === 'createTerminalTab' && command.creation?.shellOverride) {
    const { shellOverride, startupCwd } = command.creation
    const refusal = host.shellOverrideRefusal(hostId, workspace, shellOverride, startupCwd)
    if (refusal) {
      return { ok: false, code: 'shell_override_refused', message: refusal.message }
    }
  }
  const publishedBefore = holder.published(workspace)
  const applied = holder.apply(withViewDrafts(command, views), hostId)
  if (holder.published(workspace) === publishedBefore) {
    holder.republish(hostId, workspace)
  }
  if (!applied.ok) {
    return applied
  }
  userEffects(host, command, before, applied)
  if (applied.starts) {
    host.startPanes(hostId, workspace, applied.starts, options)
  }
  const navigation = options.select && options.viewId ? navigationTo(command, applied) : null
  if (navigation && options.viewId) {
    views.navigate(options.viewId, navigation)
  }
  return { ok: true, ...applied.result }
}

/** Unsaved drafts are runtime-owned facts the views report (`view.draftState`), not sender input. */
function withViewDrafts(command: LayoutCommand, views: RuntimeLayoutViews): LayoutCommand {
  if (command.type !== 'closeTabs' && command.type !== 'openEditorTab') {
    return command
  }
  const dirtyTabIds = views.draftTabIds(command.workspace)
  return dirtyTabIds.length > 0 ? { ...command, dirtyTabIds } : command
}

/** The close and move side effects of a user's command (census U17), on what the apply changed. */
function userEffects(
  host: LayoutCommandHost,
  command: LayoutCommand,
  before: WorkspaceLayoutModel,
  applied: Extract<HolderApplied, { ok: true }>
): void {
  const workspace = before.workspaces[command.workspace]
  if (!workspace) {
    return
  }
  if (command.type === 'closePane' && !applied.result.alreadyClosed) {
    const tab = findTerminal(workspace, command.tabId)
    if (tab) {
      host.closedByUser(command.workspace, {
        kind: 'pane',
        tabId: tab.entityId,
        leafId: command.leafId
      })
    }
  }
  if (command.type === 'closeTabs') {
    const closed = applied.result.closed ?? []
    host.views.forgetDrafts(command.workspace, closed)
    for (const tabId of closed) {
      const tab = findTerminal(workspace, tabId)
      if (tab) {
        host.closedByUser(command.workspace, { kind: 'tab', tabId: tab.entityId })
      }
    }
  }
  const movedTo = applied.result.tabId
  if (command.type === 'movePaneToNewTab' && movedTo) {
    const source = findTerminal(workspace, command.tabId)
    const target = findTerminal(applied.model.workspaces[command.workspace]!, movedTo)
    if (source && target) {
      host.paneMoved({
        worktreeId: command.workspace,
        sourceTabId: source.entityId,
        targetTabId: target.entityId,
        leafId: command.leafId,
        ptyId: workspace.leaves?.[command.leafId]?.ptyId ?? null
      })
    }
  }
}

/** What the sender's view shows after a `select` command: the pane or tab it made or moved. */
function navigationTo(
  command: LayoutCommand,
  applied: Extract<HolderApplied, { ok: true }>
): LayoutNavigateRequest | null {
  const { workspace } = command
  const { paneKey, tabId } = applied.result
  if (paneKey) {
    return { kind: 'focusPane', workspace, paneKey }
  }
  if (tabId) {
    return { kind: 'focusTab', workspace, tabId }
  }
  if (command.type === 'moveTab' || command.type === 'splitGroup') {
    return { kind: 'focusTab', workspace, tabId: command.tabId }
  }
  return null
}
