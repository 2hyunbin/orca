// Opening editor, browser and agent-session tabs: the tab and its content record in one apply.

import type { EditorTabView } from '../editor-tab-view-types'
import { applied, refuse, updateTab, type Applied } from './workspace-layout-command-steps'
import type { CommandOf, LayoutContext } from './workspace-layout-command-types'
import { admitsInitialSurface } from './workspace-layout-initial-surface'
import type { LayoutContentTab, WorkspaceLayoutModel } from './workspace-layout-model'
import { withWorkspace } from './workspace-layout-removal'
import { placeContentTab } from './workspace-layout-tab-commands'

function contentTab(
  context: LayoutContext,
  fields: Pick<LayoutContentTab, 'kind' | 'entityId'> & Partial<LayoutContentTab>
): LayoutContentTab {
  return {
    id: context.mintId(),
    createdAt: context.now(),
    customTitle: null,
    color: null,
    ...fields
  }
}

/** An open tab for the same file is returned instead of a second one. */
export function openEditorTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'openEditorTab'>,
  context: LayoutContext
): Applied {
  const key = command.workspace
  const existing = model.workspaces[key]?.tabs.find(
    (tab) => tab.entityId === command.fileId && tab.kind === command.contentType
  )
  if (existing) {
    return applied(withEditorView(model, key, existing.id, command.view), { tabId: existing.id })
  }
  const tab = contentTab(context, {
    kind: command.contentType,
    entityId: command.fileId,
    ...(command.preview ? { isPreview: true } : {})
  })
  const placed = placeContentTab(model, key, tab, command, context)
  let next = placed.model
  const file = command.file
  if (file) {
    const workspace = next.workspaces[key]!
    const files = (workspace.editorFiles ?? []).filter((entry) => entry.filePath !== file.filePath)
    next = withWorkspace(next, key, { ...workspace, editorFiles: [...files, file] })
  }
  return applied(withEditorView(next, key, tab.id, command.view), {
    tabId: tab.id,
    refused: placed.refused
  })
}

function withEditorView(
  model: WorkspaceLayoutModel,
  key: string,
  tabId: string,
  view: EditorTabView | undefined
): WorkspaceLayoutModel {
  if (!view) {
    return model
  }
  const workspace = model.workspaces[key]!
  return withWorkspace(model, key, {
    ...workspace,
    editorViews: { ...workspace.editorViews, [tabId]: view }
  })
}

export function openBrowserTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'openBrowserTab'>,
  context: LayoutContext
): Applied {
  const key = command.workspace
  // The tab-bar id and the browser tab record share one id, as the window mints them; a page a
  // host created alone names both, as its session row always has.
  const browserTabId = command.pageId ?? context.mintId()
  const pageId = command.pageId ?? context.mintId()
  const tab = contentTab(context, {
    kind: 'browser',
    id: browserTabId,
    entityId: browserTabId
  })
  const next = placeContentTab(model, key, tab, command, context).model
  const workspace = next.workspaces[key]!
  const browserTab = {
    id: browserTabId,
    sessionProfileId: command.profileId ?? null,
    pageIds: [pageId],
    createdAt: tab.createdAt
  }
  return applied(
    withWorkspace(next, key, {
      ...workspace,
      browserTabs: [...(workspace.browserTabs ?? []), browserTab]
    }),
    { tabId: tab.id, pageId }
  )
}

/** A browser tab's profile, which its pages' webviews open under; the same profile changes nothing. */
export function setBrowserTabProfile(
  model: WorkspaceLayoutModel,
  command: CommandOf<'setBrowserTabProfile'>
): Applied {
  const workspace = model.workspaces[command.workspace]!
  const tab = workspace.browserTabs?.find((candidate) => candidate.id === command.tabId)
  if (!tab) {
    return refuse('tab_not_found')
  }
  if (
    (tab.sessionProfileId ?? null) === command.profileId &&
    (tab.sessionPartition ?? null) === command.sessionPartition
  ) {
    return applied(model)
  }
  const next = {
    ...tab,
    sessionProfileId: command.profileId,
    sessionPartition: command.sessionPartition
  }
  return applied(
    withWorkspace(model, command.workspace, {
      ...workspace,
      browserTabs: workspace.browserTabs!.map((candidate) => (candidate === tab ? next : candidate))
    })
  )
}

export function openAgentSessionTab(
  model: WorkspaceLayoutModel,
  command: CommandOf<'openAgentSessionTab'>,
  context: LayoutContext
): Applied {
  if (command.initial && !admitsInitialSurface(model, command.workspace, command.initial)) {
    return applied(model)
  }
  const existing = model.workspaces[command.workspace]?.tabs.find(
    (entry) => entry.kind === 'agent-session' && entry.entityId === command.sessionId
  )
  if (existing) {
    // A chat keeps its one tab; a tab saved before tabs named their agent learns it here.
    return existing.agentSessionAgent
      ? applied(model, { tabId: existing.id })
      : updateTab(
          model,
          command.workspace,
          { ...existing, agentSessionAgent: command.agent },
          { tabId: existing.id }
        )
  }
  const tab = contentTab(context, {
    kind: 'agent-session',
    entityId: command.sessionId,
    agentSessionAgent: command.agent
  })
  return applied(placeContentTab(model, command.workspace, tab, command, context).model, {
    tabId: tab.id
  })
}
