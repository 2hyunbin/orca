// Startup rewrite: main persists the shared Loader's round trip of a stored partition only when
// every change comes from a rule the window-parity test proves the window shows identically.
// Anything else keeps the stored partition, and the window repairs it on load as before.

import type { ExecutionHostId } from '../execution-host'
import type { TerminalLayoutSnapshot, TerminalTab } from '../terminal-tab-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import { loadWorkspaceLayoutWithoutReport } from './workspace-layout-load'
import { diffStoredSession, type LayoutLoadChange } from './workspace-layout-load-report'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import { saveWorkspaceLayout } from './workspace-layout-save'

export type StartupLayoutRewrite =
  | { kind: 'unchanged' }
  | { kind: 'rewrite'; session: WorkspaceSessionState }
  /** `reason` names the first change no proven-neutral rule explains. */
  | { kind: 'skipped'; reason: string }

export function planStartupLayoutRewrite(
  hostId: ExecutionHostId,
  stored: WorkspaceSessionState
): StartupLayoutRewrite {
  const saved = saveWorkspaceLayout(
    loadWorkspaceLayoutWithoutReport(hostId, stored, nameBasedLoadContext())
  )
  const changes = diffStoredSession(stored, saved)
  if (changes.length === 0) {
    return { kind: 'unchanged' }
  }
  const reason = mintedLeafReason(stored, saved) ?? unexplainedChange(stored, saved, changes)
  return reason === undefined ? { kind: 'rewrite', session: saved } : { kind: 'skipped', reason }
}

function layoutLeafIds(layouts: Record<string, TerminalLayoutSnapshot> | undefined): Set<string> {
  return new Set(
    Object.values(layouts ?? {}).flatMap((layout) => [
      ...collectLayoutLeafIdsInOrder(layout.root),
      ...Object.keys(layout.ptyIdsByLeafId ?? {})
    ])
  )
}

/** Pane ids key acks, unread state, aliases and SSH leases; none is remapped at boot. */
function mintedLeafReason(
  stored: WorkspaceSessionState,
  saved: WorkspaceSessionState
): string | undefined {
  const storedLeaves = layoutLeafIds(stored.terminalLayoutsByTabId)
  const minted = [...layoutLeafIds(saved.terminalLayoutsByTabId)].find(
    (id) => !storedLeaves.has(id)
  )
  return minted === undefined ? undefined : 'mints a pane id'
}

/** Tables whose records are keyed `workspace|id`; the rest are keyed by their own id. */
const WORKSPACE_TABLES = new Set(['row', 'terminalEntry', 'entry', 'group', 'file', 'browser'])

/** `workspace|id` → [workspace, id]; workspace keys may contain `|`, ids do not. */
function splitRecord(record: string): [string, string] {
  const at = record.lastIndexOf('|')
  return [record.slice(0, at), record.slice(at + 1)]
}

function rowTerminals(row: TerminalTab, layout: TerminalLayoutSnapshot | undefined): string[] {
  return [
    ...(row.ptyId ? [row.ptyId] : []),
    ...Object.values(layout?.ptyIdsByLeafId ?? {}).filter((id): id is string => Boolean(id))
  ]
}

/** Edits a duplicate-free list only by adding and removing ids, keeping the rest in order. */
function membershipOnly(
  before: readonly string[],
  after: readonly string[],
  canAdd: (id: string) => boolean,
  canRemove: (id: string) => boolean
): boolean {
  const kept = before.filter((id) => after.includes(id))
  return (
    new Set(before).size === before.length &&
    new Set(after).size === after.length &&
    before.every((id) => after.includes(id) || canRemove(id)) &&
    after.every((id) => before.includes(id) || canAdd(id)) &&
    after.filter((id) => before.includes(id)).every((id, index) => kept[index] === id)
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}
}

function asIds(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((id) => typeof id === 'string') ? value : undefined
}

/**
 * Proven neutral by `startup-window-parity.test.ts`:
 * - adoption: a row with no tab-bar entry that still names its terminal joins its stored group;
 * - subsumed row: a row outside the tab bar whose every terminal another row of its workspace
 *   still holds is dropped, and a selection naming it follows its twin;
 * - a tab listed by two groups stays only in the group its tab-bar entry names.
 */
function unexplainedChange(
  stored: WorkspaceSessionState,
  saved: WorkspaceSessionState,
  changes: readonly LayoutLoadChange[]
): string | undefined {
  const adopted = new Map<string, Set<string>>()
  const dropped = new Map<string, Set<string>>()
  for (const change of changes) {
    if (change.field !== '*' || change.record.endsWith('|$order')) {
      continue
    }
    const [key, id] = splitRecord(change.record)
    if (change.table === 'terminalEntry' && change.before === undefined) {
      adopted.set(key, (adopted.get(key) ?? new Set()).add(id))
    } else if (change.table === 'row' && change.after === undefined) {
      dropped.set(key, (dropped.get(key) ?? new Set()).add(id))
    }
  }
  const droppedAnywhere = new Set([...dropped.values()].flatMap((ids) => [...ids]))
  const savedRowIds = new Set(
    Object.values(saved.tabsByWorktree ?? {}).flatMap((rows) => rows.map((row) => row.id))
  )

  const adoptionIsNeutral = (key: string, value: unknown): boolean => {
    const entry = asRecord(value)
    const row = stored.tabsByWorktree?.[key]?.find((candidate) => candidate.id === entry.entityId)
    const groups = stored.tabGroups?.[key] ?? []
    // The window adopts only a row that names its terminal (a ghost row gets no tab), and into
    // its active group, which is the Loader's first group only when there is one.
    return (
      entry.id === entry.entityId &&
      Boolean(row?.ptyId) &&
      groups.length === 1 &&
      groups[0]?.id === entry.groupId
    )
  }
  const dropIsNeutral = (key: string, tabId: string): boolean => {
    const row = stored.tabsByWorktree?.[key]?.find((candidate) => candidate.id === tabId)
    if (!row || savedRowIds.has(tabId)) {
      return false
    }
    const held = new Set(
      (saved.tabsByWorktree?.[key] ?? []).flatMap((kept) =>
        rowTerminals(kept, saved.terminalLayoutsByTabId?.[kept.id])
      )
    )
    const terminals = rowTerminals(row, stored.terminalLayoutsByTabId?.[tabId])
    return terminals.length > 0 && terminals.every((ptyId) => held.has(ptyId))
  }
  const selectionFollows = (before: unknown, after: unknown): boolean =>
    typeof before === 'string' &&
    droppedAnywhere.has(before) &&
    typeof after === 'string' &&
    savedRowIds.has(after)

  for (const change of changes) {
    const { table, field, before, after } = change
    const [key, id] = WORKSPACE_TABLES.has(table) ? splitRecord(change.record) : ['', change.record]
    const neutral = (() => {
      if (table === 'terminalEntry' && field === '*' && before === undefined) {
        return adoptionIsNeutral(key, after)
      }
      if (table === 'row' && field === '*' && after === undefined) {
        return dropIsNeutral(key, id)
      }
      if (table === 'layout' && field === '*' && after === undefined) {
        return droppedAnywhere.has(id)
      }
      const [beforeIds, afterIds] = [asIds(before), asIds(after)]
      if (field === '$order' && beforeIds && afterIds && (table === 'entry' || table === 'row')) {
        const canAdd = (tabId: string) => table === 'entry' && Boolean(adopted.get(key)?.has(tabId))
        const canRemove = (tabId: string) =>
          table === 'row' && Boolean(dropped.get(key)?.has(tabId))
        return membershipOnly(beforeIds, afterIds, canAdd, canRemove)
      }
      if (table === 'group' && field === 'tabOrder' && beforeIds && afterIds) {
        const otherGroups = (saved.tabGroups?.[key] ?? []).filter((group) => group.id !== id)
        const listedElsewhere = (tabId: string) =>
          otherGroups.some((group) => group.tabOrder.includes(tabId))
        const canAdd = (tabId: string) => Boolean(adopted.get(key)?.has(tabId))
        return membershipOnly(beforeIds, afterIds, canAdd, listedElsewhere)
      }
      if (table === 'session' && field === 'activeTabId') {
        return selectionFollows(before, after)
      }
      if (table === 'session' && field === 'activeTabIdByWorktree') {
        const [was, now] = [asRecord(before), asRecord(after)]
        return Object.keys({ ...was, ...now }).every(
          (worktree) =>
            was[worktree] === now[worktree] || selectionFollows(was[worktree], now[worktree])
        )
      }
      return false
    })()
    if (!neutral) {
      return `${table}.${field}`
    }
  }
  return undefined
}
