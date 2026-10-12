import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult
} from '../shared/runtime-types'
import { collectTabGroupLayoutGroupIds } from '../shared/workspace-layout/tab-group-moves'

export type WorkspaceTabKind = 'terminal' | 'chat' | 'editor' | 'browser'

/** One Orca tab as the CLI shows it: the host's tab id plus the id each kind's own commands take. */
export type WorkspaceTabRow = {
  tabId: string
  kind: WorkspaceTabKind
  title: string
  active: boolean
  pinned: boolean
  worktreeId: string
  /** Terminal: handles of the tab's panes that have one yet. */
  terminals?: string[]
  /** Chat */
  sessionId?: string
  agent?: string
  /** Editor */
  filePath?: string
  unsaved?: boolean
  /** Browser: the id `--page` takes. */
  browserPageId?: string | null
  url?: string
}

type WorkspaceTabInventoryHold = Pick<
  RuntimeMobileSessionTabsResult,
  'agentSessionsUnverifiable' | 'clientHostedPagesUnreconciled'
> & { worktreeId: string }

export type WorkspaceTabListResult = {
  tabs: WorkspaceTabRow[]
  incompleteWorktrees?: WorkspaceTabInventoryHold[]
}

export function projectWorkspaceTabList(
  snapshots: RuntimeMobileSessionTabsResult[]
): WorkspaceTabListResult {
  const incompleteWorktrees: WorkspaceTabInventoryHold[] = []
  for (const snapshot of snapshots) {
    if (snapshot.agentSessionsUnverifiable || snapshot.clientHostedPagesUnreconciled) {
      incompleteWorktrees.push({
        worktreeId: snapshot.worktree,
        ...(snapshot.agentSessionsUnverifiable ? { agentSessionsUnverifiable: true } : {}),
        ...(snapshot.clientHostedPagesUnreconciled ? { clientHostedPagesUnreconciled: true } : {})
      })
    }
  }
  return {
    tabs: snapshots.flatMap(projectWorkspaceTabRows),
    ...(incompleteWorktrees.length ? { incompleteWorktrees } : {})
  }
}

function rowFor(tab: RuntimeMobileSessionClientTab, worktreeId: string): WorkspaceTabRow {
  const base = {
    title: tab.title,
    active: tab.isActive,
    pinned: tab.isPinned === true,
    worktreeId
  }
  switch (tab.type) {
    case 'terminal':
      return {
        ...base,
        tabId: tab.parentTabId,
        kind: 'terminal',
        terminals: tab.status === 'ready' ? [tab.terminal] : []
      }
    case 'agent-session':
      return { ...base, tabId: tab.id, kind: 'chat', sessionId: tab.sessionId, agent: tab.agent }
    case 'markdown':
    case 'file':
      return {
        ...base,
        tabId: tab.id,
        kind: 'editor',
        filePath: tab.filePath,
        unsaved: tab.isDirty
      }
    case 'browser':
      return {
        ...base,
        tabId: tab.id,
        kind: 'browser',
        browserPageId: tab.browserPageId,
        url: tab.url
      }
  }
}

/** The host lists one row per terminal pane; a split terminal tab becomes one row here. */
export function projectWorkspaceTabRows(
  snapshot: RuntimeMobileSessionTabsResult
): WorkspaceTabRow[] {
  const rows: WorkspaceTabRow[] = []
  const terminalRows = new Map<string, WorkspaceTabRow>()
  for (const tab of snapshot.tabs) {
    const row = rowFor(tab, snapshot.worktree)
    const existing = row.kind === 'terminal' ? terminalRows.get(row.tabId) : undefined
    if (existing) {
      existing.terminals = [...(existing.terminals ?? []), ...(row.terminals ?? [])]
      existing.active ||= row.active
      continue
    }
    if (row.kind === 'terminal') {
      terminalRows.set(row.tabId, row)
    }
    rows.push(row)
  }
  return orderWorkspaceTabRows(rows, snapshot)
}

function orderWorkspaceTabRows(
  rows: WorkspaceTabRow[],
  snapshot: RuntimeMobileSessionTabsResult
): WorkspaceTabRow[] {
  const groups = snapshot.tabGroups ?? []
  const groupsById = new Map(groups.map((group) => [group.id, group]))
  const groupIds = snapshot.tabGroupLayout
    ? [...collectTabGroupLayoutGroupIds(snapshot.tabGroupLayout)]
    : groups.map((group) => group.id)
  if (
    groupsById.size !== groups.length ||
    groupIds.length !== groups.length ||
    groupIds.some((id) => !groupsById.has(id))
  ) {
    return rows
  }
  const remaining = new Map(rows.map((row) => [row.tabId, row]))
  const ordered: WorkspaceTabRow[] = []
  const seen = new Set<string>()
  for (const groupId of groupIds) {
    for (const tabId of groupsById.get(groupId)?.tabOrder ?? []) {
      if (seen.has(tabId)) {
        return rows
      }
      seen.add(tabId)
      const row = remaining.get(tabId)
      if (row) {
        ordered.push(row)
        remaining.delete(tabId)
      }
    }
  }
  // Why: partial host groups cannot place the remaining rows reliably.
  return remaining.size === 0 && ordered.length === rows.length ? ordered : rows
}

function rowDetail(row: WorkspaceTabRow): string {
  switch (row.kind) {
    case 'terminal':
      return row.terminals?.length ? row.terminals.join(', ') : 'handle unavailable'
    case 'chat':
      return row.agent ?? ''
    case 'editor':
      return `${row.filePath ?? ''}${row.unsaved ? ' (unsaved)' : ''}`
    case 'browser':
      return `${row.browserPageId ?? 'no page'}  ${row.url ?? ''}`
  }
}

export function formatWorkspaceTabList(result: WorkspaceTabListResult): string {
  const holds = result.incompleteWorktrees ?? []
  if (result.tabs.length === 0 && holds.length === 0) {
    return 'No tabs open.'
  }
  const worktrees = new Set(result.tabs.map((row) => row.worktreeId))
  const lines = holds.map((hold) => {
    const reasons = [
      ...(hold.agentSessionsUnverifiable ? ['chat inventory unavailable'] : []),
      ...(hold.clientHostedPagesUnreconciled
        ? ['client-hosted browser inventory not yet reconciled']
        : [])
    ]
    return `Inventory incomplete for ${hold.worktreeId}: ${reasons.join('; ')}.`
  })
  let currentWorktree: string | null = null
  for (const row of result.tabs) {
    if (worktrees.size > 1 && row.worktreeId !== currentWorktree) {
      currentWorktree = row.worktreeId
      lines.push(`${row.worktreeId}:`)
    }
    const marker = row.active ? '* ' : '  '
    lines.push(`${marker}${row.tabId}  ${row.kind}  ${row.title}  ${rowDetail(row)}`.trimEnd())
  }
  return lines.join('\n')
}
