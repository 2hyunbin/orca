// A layout intent for a workspace a paired server's frames draw goes to that server's main
// (design H5c), under the server's ids. Only the intents on one list do; any other keeps today's
// path, as does every intent for a server that does not advertise `layout.intents.v1`.

import type {
  LayoutApplyReply,
  LayoutCommandResult
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { LayoutApplyHandlers, WindowLayoutCommand } from './layout-apply-send'
import { serverLayoutApplyRoute, type ServerLayoutApplyRoute } from './server-layout-apply-routes'

/**
 * The intents a server's main takes from a paired desktop now: tab and group placement, and pane
 * sizes and moves, which main applies with no window. Not yet: anything that starts, stops or
 * closes a terminal, until main does that itself headless (D2), nor editor opens (D3a).
 */
export const SERVER_ROUTED_LAYOUT_COMMANDS = [
  'moveTab',
  'splitGroup',
  'setGroupRatios',
  'setPaneRatios',
  'equalizePanes',
  'movePane'
] as const satisfies readonly WindowLayoutCommand['type'][]

type ServerRoutedCommand = Extract<
  WindowLayoutCommand,
  { type: (typeof SERVER_ROUTED_LAYOUT_COMMANDS)[number] }
>

const ROUTED: ReadonlySet<string> = new Set(SERVER_ROUTED_LAYOUT_COMMANDS)

function isServerRouted(command: WindowLayoutCommand): command is ServerRoutedCommand {
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
    handlers.apply(resultForDesktop(reply.result, server.route))
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
