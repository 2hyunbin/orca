// Layout-owner builds, before main holds browser and chat records (D3b): a workspace main owns
// publishes its terminal and editor rows from main's layout (projectSessionTabs). The window's
// snapshot still supplies the rows main's model does not hold (browser, chat, diff and other
// view-only editor rows) and the facts only the window has (terminal theme, launch drafts, a
// markdown view's mode and draft version).

import type { RuntimeMobileSessionSnapshotTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import type {
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-session-contracts'

type Row = RuntimeMobileSessionSnapshotTab

/** Main's projection of the rows (projectSessionTabs): the snapshot minus the runtime's stamps. */
export type MainSessionTabRows = Omit<
  RuntimeMobileSessionTabsSnapshot,
  'publicationEpoch' | 'snapshotVersion' | 'worktreeInstanceId' | 'retiredTerminalSurfaces'
>

/**
 * Rows main's layout answers for: terminals and edit-mode files (the model holds no diff or
 * preview-only tab). Any other row is the window's until D3b.
 */
function isMainRow(row: Row): boolean {
  return (
    row.type === 'terminal' ||
    (row.type === 'file' && row.mode !== 'diff') ||
    (row.type === 'markdown' && row.mode === 'edit')
  )
}

/** Main's row with the fields only the window knows, from the window's row of the same id. */
function withWindowFacts(row: Row, windowRow: Row | undefined): Row {
  if (row.type === 'terminal' && windowRow?.type === 'terminal') {
    return {
      ...row,
      ...(windowRow.terminalTheme ? { terminalTheme: windowRow.terminalTheme } : {}),
      ...(windowRow.launchDraft !== undefined ? { launchDraft: windowRow.launchDraft } : {}),
      ...(windowRow.launchDraftCreatedAt !== undefined
        ? { launchDraftCreatedAt: windowRow.launchDraftCreatedAt }
        : {})
    }
  }
  if (row.type === 'markdown' && windowRow?.type === 'markdown') {
    return { ...row, mode: windowRow.mode, documentVersion: windowRow.documentVersion }
  }
  return row
}

/** Each window-only id placed after the id it follows in the window's group, else at the end. */
function withWindowOnlyIds(
  tabOrder: readonly string[],
  windowOrder: readonly string[],
  windowOnly: ReadonlySet<string>
): string[] {
  const order = [...tabOrder]
  windowOrder.forEach((id, index) => {
    if (!windowOnly.has(id) || order.includes(id)) {
      return
    }
    const after = windowOrder
      .slice(0, index)
      .toReversed()
      .find((previous) => order.includes(previous))
    order.splice(after === undefined ? 0 : order.indexOf(after) + 1, 0, id)
  })
  return order
}

/**
 * The window's snapshot of a workspace main owns, with main's terminal and editor rows, groups
 * and selection. The window keeps its publication stamps, so the snapshot fences hold as today.
 */
export function withMainSessionTabRows(
  published: RuntimeMobileSessionTabsSnapshot,
  projected: MainSessionTabRows
): RuntimeMobileSessionTabsSnapshot {
  const windowRows = new Map(published.tabs.map((row) => [row.id, row]))
  const projectedIds = new Set(projected.tabs.map((row) => row.id))
  const windowOnly = published.tabs.filter((row) => !projectedIds.has(row.id) && !isMainRow(row))
  // A main-held row is main's; a browser or chat row stays the window's while both list it.
  const rows = projected.tabs.map((row) =>
    isMainRow(row) ? withWindowFacts(row, windowRows.get(row.id)) : (windowRows.get(row.id) ?? row)
  )
  const windowOnlyIds = new Set(windowOnly.map((row) => row.id))
  const windowGroups = new Map((published.tabGroups ?? []).map((group) => [group.id, group]))
  const tabGroups: RuntimeMobileSessionTabGroup[] = (projected.tabGroups ?? []).map((group) => ({
    ...group,
    tabOrder: withWindowOnlyIds(
      group.tabOrder,
      windowGroups.get(group.id)?.tabOrder ?? [],
      windowOnlyIds
    )
  }))
  const placed = new Set(tabGroups.flatMap((group) => group.tabOrder))
  // A window-only row in a group main does not list keeps the window's group.
  for (const group of published.tabGroups ?? []) {
    const stray = group.tabOrder.filter((id) => windowOnlyIds.has(id) && !placed.has(id))
    if (stray.length > 0 && !tabGroups.some((entry) => entry.id === group.id)) {
      tabGroups.push({ ...group, tabOrder: stray })
    }
  }
  // The window's selection stands only when it shows a row main does not list.
  const windowActive = published.activeTabId ? windowRows.get(published.activeTabId) : undefined
  const selection =
    windowActive && windowOnlyIds.has(windowActive.id)
      ? {
          activeGroupId: published.activeGroupId,
          activeTabId: published.activeTabId,
          activeTabType: published.activeTabType
        }
      : {
          activeGroupId: projected.activeGroupId,
          activeTabId: projected.activeTabId,
          activeTabType: projected.activeTabType
        }
  const activeId = selection.activeTabId
  const { tabGroups: _windowGroups, tabGroupLayout: _windowLayout, ...stamps } = published
  return {
    ...stamps,
    ...selection,
    ...(tabGroups.length > 0 ? { tabGroups } : {}),
    ...(projected.tabGroupLayout ? { tabGroupLayout: projected.tabGroupLayout } : {}),
    tabs: [...rows, ...windowOnly].map((row) =>
      row.isActive === (row.id === activeId) ? row : { ...row, isActive: row.id === activeId }
    )
  }
}
