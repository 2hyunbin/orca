// A layout intent for a workspace a paired server's frames draw goes to that server's main
// (design H5c), under the server's ids. Only the intents on one list do; any other keeps today's
// path, as does every intent for a server that does not advertise `layout.intents.v1`. Closes,
// starts and terminal names keep their RPCs (session.tabs.close, terminal.close, terminal.split,
// session.tabs.createTerminal, terminal.rename), which that server's main applies to its own layout.

import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'

import type {
  LayoutApplyReply,
  LayoutCommandResult
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { LayoutApplyHandlers, WindowLayoutCommand } from './layout-apply-send'
import { serverLayoutApplyRoute, type ServerLayoutApplyRoute } from './server-layout-apply-routes'

/**
 * The intents a server's main applies from a paired desktop exactly as from its own window: tab and
 * group placement, pane sizes and moves, a tab's props and non-terminal names, and a tab's chat
 * pane. Never a close (closeTabs, closePane): main takes a window's close as already stopped and
 * stops nothing, while this desktop cannot stop a server's terminals; nor a start (createTerminalTab,
 * splitPane), sleep or wake, which need main's terminal side. Their RPCs reach that main instead.
 */
export const SERVER_ROUTED_LAYOUT_COMMANDS = [
  'moveTab',
  'splitGroup',
  'setGroupRatios',
  'setPaneRatios',
  'equalizePanes',
  'movePane',
  'setTabProps',
  'setChatPane',
  'renameTab'
] as const satisfies readonly WindowLayoutCommand['type'][]

type ServerRoutedCommand = Extract<
  WindowLayoutCommand,
  { type: (typeof SERVER_ROUTED_LAYOUT_COMMANDS)[number] }
>

const ROUTED: ReadonlySet<string> = new Set(SERVER_ROUTED_LAYOUT_COMMANDS)

function isServerRouted(command: WindowLayoutCommand): command is ServerRoutedCommand {
  // A terminal's own name goes by terminal.rename, which also names the server's terminal.
  if (command.type === 'renameTab' && command.kind === 'custom') {
    return !isWebTerminalSurfaceTabId(command.tabId)
  }
  // This desktop's guess that a launched agent exited must not clear the server's relaunch record.
  if (command.type === 'setTabProps' && command.clearLaunchAgent) {
    return false
  }
  return ROUTED.has(command.type)
}

/** An intent as it goes to a server's main, and how its answer shows here. */
export type ServerLayoutApply = {
  route: ServerLayoutApplyRoute
  command: WindowLayoutCommand
}

/** Null when the intent keeps today's path: off the list, a workspace no server frames draw, or a
 *  tab the server's frames do not hold. */
export function serverLayoutApplyFor(
  environmentId: string,
  worktreeId: string,
  command: WindowLayoutCommand
): ServerLayoutApply | null {
  if (!isServerRouted(command)) {
    return null
  }
  const route = serverLayoutApplyRoute(environmentId, worktreeId)
  if (!route) {
    return null
  }
  if (command.type === 'setGroupRatios') {
    // Group ids are the server's own: frames carry them unchanged.
    return { route, command }
  }
  const tabId = route.serverTabId(command.tabId)
  return tabId ? { route, command: { ...command, tabId } } : null
}

/**
 * Shows a server's answer. A refusal, or a call that never reached it, redraws the workspace from
 * the server's frames: nothing applies here instead, since only that main changes its layout.
 */
export function handleServerLayoutReply(
  server: ServerLayoutApply,
  type: WindowLayoutCommand['type'],
  reply: LayoutApplyReply | null,
  handlers: LayoutApplyHandlers
): void {
  if (reply?.ok) {
    handlers.apply(resultForDesktop(reply.result, server.route), {
      framesKey: server.route.environmentId,
      routed: true
    })
    return
  }
  const code = reply ? reply.code : 'call_failed'
  console.warn(`[layout-owner] ${type} refused by the server:`, code)
  server.route.redraw()
  handlers.refused?.(code)
}

function resultForDesktop(
  result: LayoutCommandResult,
  route: ServerLayoutApplyRoute
): LayoutCommandResult {
  return result.tabId === undefined
    ? result
    : { ...result, tabId: route.desktopTabId(result.tabId) }
}
