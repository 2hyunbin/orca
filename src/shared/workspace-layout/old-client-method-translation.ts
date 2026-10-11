// Old layout methods' params as layout commands (design 2.6). Pure: the handler resolves the
// worktree selector and terminal handles, applies the commands and shapes today's reply.

import type { z } from 'zod'
import type { MoveTab } from '../rpc-contract/session-tabs-schemas-params'
import { isTerminalLeafId } from '../stable-pane-id'
import { isValidHostTerminalTabId } from '../terminal-tab-id'
import type { TerminalPaneSplitDirection } from '../terminal-tab-types'
import { resolveSessionTabRow } from './old-client-session-tab-rows'
import { collectLayoutLeafIdsInOrder, layoutContainsLeafId } from './terminal-pane-tree'
import type { LayoutCommand, LayoutRefusalCode } from './workspace-layout-command-types'
import {
  paneKeyOf,
  type LayoutTerminalTab,
  type WorkspaceLayout,
  type WorkspaceLayoutModel
} from './workspace-layout-model'

export type MethodTranslation =
  | { ok: true; commands: LayoutCommand[] }
  | { ok: false; code: LayoutRefusalCode }

const to = (...commands: LayoutCommand[]): MethodTranslation => ({ ok: true, commands })
const refused = (code: LayoutRefusalCode): MethodTranslation => ({ ok: false, code })

/**
 * `terminal.create`. An old desktop names the pane it already drew (`tabId`/`leafId`): a pane the
 * model has starts; a new pane in a tab the model has splits that tab; unused ids create a tab
 * with them. Ids that are missing or malformed are minted, as `allocateTerminalPaneIdentity` does.
 */
export function translateTerminalCreate(
  model: WorkspaceLayoutModel,
  workspaceKey: string,
  params: { tabId?: string; leafId?: string; title?: string }
): MethodTranslation {
  const create = (ids: { tabId?: string; leafId?: string }): MethodTranslation =>
    to({
      type: 'createTerminalTab',
      workspace: workspaceKey,
      ...ids,
      ...(params.title ? { title: params.title } : {})
    })
  const tabId = params.tabId?.trim()
  const { leafId } = params
  if (!tabId || !isValidHostTerminalTabId(tabId) || !leafId || !isTerminalLeafId(leafId)) {
    return create({})
  }
  const workspace = model.workspaces[workspaceKey]
  const target = workspace ? resolveSessionTabRow(workspace, tabId)?.tab : undefined
  if (target && target.kind !== 'terminal') {
    return refused('invalid_params')
  }
  if (target && layoutContainsLeafId(target.panes.root, leafId)) {
    return to({
      type: 'startPane',
      workspace: workspaceKey,
      paneKey: paneKeyOf(target.entityId, leafId)
    })
  }
  // Pane ids are unique in the partition: one named elsewhere is not this pane.
  if (paneIdInUse(model, leafId)) {
    return refused('invalid_params')
  }
  if (!target) {
    return create({ tabId, leafId })
  }
  // The desktop sends its tree after, through updatePaneLayout, which moves the pane where it drew it.
  const besideLeafId = collectLayoutLeafIdsInOrder(target.panes.root).at(-1)
  return besideLeafId
    ? to({
        type: 'splitPane',
        workspace: workspaceKey,
        tabId: target.id,
        leafId: besideLeafId,
        direction: 'vertical',
        newLeafId: leafId
      })
    : refused('pane_not_found')
}

function paneIdInUse(model: WorkspaceLayoutModel, leafId: string): boolean {
  return Object.values(model.workspaces).some((workspace) =>
    workspace.tabs.some(
      (tab) => tab.kind === 'terminal' && layoutContainsLeafId(tab.panes.root, leafId)
    )
  )
}

/** `session.tabs.createTerminal`; spawn inputs (command, env, agent) stay with the handler. */
export function translateCreateTerminalTab(
  workspaceKey: string,
  workspace: WorkspaceLayout | undefined,
  params: { afterTabId?: string; targetGroupId?: string; viewMode?: 'terminal' | 'chat' }
): MethodTranslation {
  const after = params.afterTabId && workspace && resolveSessionTabRow(workspace, params.afterTabId)
  return to({
    type: 'createTerminalTab',
    workspace: workspaceKey,
    ...(after ? { afterTabId: after.tab.id } : {}),
    ...(params.targetGroupId ? { groupId: params.targetGroupId } : {}),
    ...(params.viewMode ? { viewMode: params.viewMode } : {})
  })
}

export function translateSetTabProps(
  workspaceKey: string,
  workspace: WorkspaceLayout,
  params: {
    tabId: string
    color?: string | null
    isPinned?: boolean
    viewMode?: 'terminal' | 'chat'
  }
): MethodTranslation {
  const target = resolveSessionTabRow(workspace, params.tabId)
  if (!target) {
    return refused('tab_not_found')
  }
  return to({
    type: 'setTabProps',
    workspace: workspaceKey,
    tabId: target.tab.id,
    ...(params.color !== undefined ? { color: params.color } : {}),
    ...(params.isPinned !== undefined ? { isPinned: params.isPinned } : {}),
    ...(params.viewMode !== undefined ? { viewMode: params.viewMode } : {})
  })
}

/**
 * `session.tabs.close`: a pane row closes its pane, any other row its tab. Pinned tabs close: old
 * clients cannot confirm. A row that is already gone closes as already closed (#10747).
 */
export function translateSessionTabClose(
  workspaceKey: string,
  workspace: WorkspaceLayout | undefined,
  params: { tabId: string; force?: boolean }
): MethodTranslation {
  const target = workspace ? resolveSessionTabRow(workspace, params.tabId) : null
  if (target?.leafId) {
    return to({
      type: 'closePane',
      workspace: workspaceKey,
      tabId: target.tab.id,
      leafId: target.leafId
    })
  }
  return to({
    type: 'closeTabs',
    workspace: workspaceKey,
    tabIds: [target?.tab.id ?? params.tabId],
    ...(params.force ? { force: true } : {})
  })
}

/** `session.tabs.move`; a `reorder` becomes the moves that produce the sent order. */
export function translateSessionTabMove(
  workspaceKey: string,
  workspace: WorkspaceLayout,
  params: z.infer<typeof MoveTab>
): MethodTranslation {
  const tab = resolveSessionTabRow(workspace, params.tabId)?.tab
  if (!tab) {
    return refused('tab_not_found')
  }
  const target = workspace.groups.find((group) => group.id === params.targetGroupId)
  if (!target) {
    return refused('group_not_found')
  }
  const on = { workspace: workspaceKey, toGroupId: target.id }
  if (params.kind === 'split') {
    return to({
      type: 'splitGroup',
      workspace: workspaceKey,
      tabId: tab.id,
      besideGroupId: target.id,
      direction: params.splitDirection
    })
  }
  if (params.kind === 'move-to-group') {
    return to({
      ...on,
      type: 'moveTab',
      tabId: tab.id,
      index: params.index ?? target.tabOrder.length
    })
  }
  const members = new Set([...target.tabOrder, tab.id])
  const sent = params.tabOrder.flatMap((rowId) => {
    const id = resolveSessionTabRow(workspace, rowId)?.tab.id
    return id && members.has(id) ? [id] : []
  })
  const wanted = [...new Set(sent)]
  if (!wanted.includes(tab.id)) {
    return refused('invalid_params')
  }
  // Tabs the sender left out keep their relative order after the ones it placed.
  wanted.push(...[...members].filter((id) => !wanted.includes(id)))
  const commands: LayoutCommand[] = []
  const order = [...target.tabOrder]
  if (!order.includes(tab.id)) {
    const index = wanted.indexOf(tab.id)
    commands.push({ ...on, type: 'moveTab', tabId: tab.id, index })
    order.splice(index, 0, tab.id)
  }
  wanted.forEach((id, index) => {
    if (order[index] !== id) {
      order.splice(order.indexOf(id), 1)
      order.splice(index, 0, id)
      commands.push({ ...on, type: 'moveTab', tabId: id, index })
    }
  })
  return to(...commands)
}

type ResolvedPane = { tab: LayoutTerminalTab; leafId: string }

/** `terminal.split` on a resolved handle; it splits below when no direction is sent, as today. */
export function translateTerminalSplit(
  workspaceKey: string,
  pane: ResolvedPane,
  direction: TerminalPaneSplitDirection | undefined
): MethodTranslation {
  return to({
    type: 'splitPane',
    workspace: workspaceKey,
    tabId: pane.tab.id,
    leafId: pane.leafId,
    direction: direction ?? 'horizontal'
  })
}

/** `terminal.rename`: an empty title resets to the generated one, as today. */
export function translateTerminalRename(
  workspaceKey: string,
  pane: ResolvedPane,
  title: string | null
): MethodTranslation {
  return to({
    type: 'renameTab',
    workspace: workspaceKey,
    tabId: pane.tab.id,
    kind: 'custom',
    title: title || null
  })
}

export function translateTerminalClose(
  workspaceKey: string,
  pane: ResolvedPane
): MethodTranslation {
  return to({ type: 'closePane', workspace: workspaceKey, tabId: pane.tab.id, leafId: pane.leafId })
}

export function translateTerminalCloseTab(
  workspaceKey: string,
  pane: ResolvedPane
): MethodTranslation {
  return to({ type: 'closeTabs', workspace: workspaceKey, tabIds: [pane.tab.id] })
}
