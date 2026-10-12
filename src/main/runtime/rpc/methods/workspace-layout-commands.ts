// The `layout.*` commands (design 2.1). Advertised as `workspace-layout.v1` and not on the phone
// allowlist: in phase 1 only the local window sends them. Each replies `{ok, ...ids}` or
// `{ok: false, code}` once applied; starts run after the reply.

import type { z } from 'zod'
import type { LayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import {
  DESKTOP_VIEW_ID,
  deviceViewId,
  type LayoutViewId
} from '../../../../shared/workspace-layout/workspace-layout-views'
import {
  LayoutClosePaneParams,
  LayoutCloseTabsParams,
  LayoutCreateTerminalTabParams,
  LayoutEqualizePanesParams,
  LayoutMovePaneParams,
  LayoutMovePaneToNewTabParams,
  LayoutMoveTabParams,
  LayoutOpenAgentSessionTabParams,
  LayoutOpenBrowserTabParams,
  LayoutOpenEditorTabParams,
  LayoutPromotePreviewTabParams,
  LayoutRenamePaneParams,
  LayoutRenameTabParams,
  LayoutRestartPaneParams,
  LayoutSetChatPaneParams,
  LayoutSetGroupRatiosParams,
  LayoutSetPaneRatiosParams,
  LayoutSetTabPropsParams,
  LayoutSplitGroupParams,
  LayoutSplitPaneParams,
  LayoutStartPaneParams
} from '../../../../shared/rpc-contract/workspace-layout-command-params'
import { defineMethod, type RpcContext } from '../core'

type CommandParams = {
  workspace: string
  select?: boolean
  initialSize?: { cols: number; rows: number }
  cwd?: string
}

/** The sender's own view: a paired device's, else the local window's. */
export function senderViewId(ctx: Pick<RpcContext, 'pairedDeviceId'>): LayoutViewId {
  return ctx.pairedDeviceId ? deviceViewId(ctx.pairedDeviceId) : DESKTOP_VIEW_ID
}

function layoutCommand<TName extends string, TSchema extends z.ZodType<CommandParams>>(
  name: TName,
  params: TSchema,
  toCommand: (params: TSchema['_output']) => LayoutCommand
) {
  return defineMethod({
    name,
    permission: 'workspace',
    params,
    handler: async (parsed: TSchema['_output'], ctx: RpcContext) =>
      ctx.runtime.layoutCommands.apply(toCommand(parsed), {
        viewId: senderViewId(ctx),
        ...(parsed.select ? { select: true } : {}),
        ...(parsed.initialSize ? { initialSize: parsed.initialSize } : {}),
        ...(parsed.cwd ? { cwd: parsed.cwd } : {})
      })
  })
}

export const WORKSPACE_LAYOUT_COMMAND_METHODS = [
  layoutCommand(
    'layout.createTerminalTab',
    LayoutCreateTerminalTabParams,
    ({ select: _s, initialSize: _i, ...p }) => ({ type: 'createTerminalTab', ...p })
  ),
  layoutCommand(
    'layout.splitPane',
    LayoutSplitPaneParams,
    ({ select: _s, initialSize: _i, cwd: _c, ...p }) => ({ type: 'splitPane', ...p })
  ),
  layoutCommand('layout.closePane', LayoutClosePaneParams, ({ select: _s, ...p }) => ({
    type: 'closePane',
    ...p
  })),
  layoutCommand('layout.closeTabs', LayoutCloseTabsParams, ({ select: _s, ...p }) => ({
    type: 'closeTabs',
    ...p
  })),
  layoutCommand('layout.moveTab', LayoutMoveTabParams, ({ select: _s, ...p }) => ({
    type: 'moveTab',
    ...p
  })),
  layoutCommand('layout.splitGroup', LayoutSplitGroupParams, ({ select: _s, ...p }) => ({
    type: 'splitGroup',
    ...p
  })),
  layoutCommand('layout.setGroupRatios', LayoutSetGroupRatiosParams, ({ select: _s, ...p }) => ({
    type: 'setGroupRatios',
    ...p
  })),
  layoutCommand('layout.setPaneRatios', LayoutSetPaneRatiosParams, ({ select: _s, ...p }) => ({
    type: 'setPaneRatios',
    ...p
  })),
  layoutCommand('layout.movePane', LayoutMovePaneParams, ({ select: _s, ...p }) => ({
    type: 'movePane',
    ...p
  })),
  layoutCommand('layout.equalizePanes', LayoutEqualizePanesParams, ({ select: _s, ...p }) => ({
    type: 'equalizePanes',
    ...p
  })),
  layoutCommand(
    'layout.movePaneToNewTab',
    LayoutMovePaneToNewTabParams,
    ({ select: _s, ...p }) => ({ type: 'movePaneToNewTab', ...p })
  ),
  layoutCommand('layout.renameTab', LayoutRenameTabParams, ({ select: _s, ...p }) => ({
    type: 'renameTab',
    ...p
  })),
  layoutCommand('layout.renamePane', LayoutRenamePaneParams, ({ select: _s, ...p }) => ({
    type: 'renamePane',
    ...p
  })),
  layoutCommand('layout.setTabProps', LayoutSetTabPropsParams, ({ select: _s, ...p }) => ({
    type: 'setTabProps',
    ...p
  })),
  layoutCommand('layout.setChatPane', LayoutSetChatPaneParams, ({ select: _s, ...p }) => ({
    type: 'setChatPane',
    ...p
  })),
  layoutCommand('layout.openEditorTab', LayoutOpenEditorTabParams, ({ select: _s, ...p }) => ({
    type: 'openEditorTab',
    ...p
  })),
  layoutCommand(
    'layout.promotePreviewTab',
    LayoutPromotePreviewTabParams,
    ({ select: _s, ...p }) => ({ type: 'promotePreviewTab', ...p })
  ),
  layoutCommand('layout.openBrowserTab', LayoutOpenBrowserTabParams, ({ select: _s, ...p }) => ({
    type: 'openBrowserTab',
    ...p
  })),
  layoutCommand(
    'layout.openAgentSessionTab',
    LayoutOpenAgentSessionTabParams,
    ({ select: _s, ...p }) => ({ type: 'openAgentSessionTab', ...p })
  ),
  layoutCommand(
    'layout.startPane',
    LayoutStartPaneParams,
    ({ select: _s, initialSize: _i, ...p }) => ({ type: 'startPane', ...p })
  ),
  layoutCommand(
    'layout.restartPane',
    LayoutRestartPaneParams,
    ({ select: _s, initialSize: _i, ...p }) => ({ type: 'restartPane', ...p })
  )
]
