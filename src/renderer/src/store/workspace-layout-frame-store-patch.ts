// Lays slices rebuilt from layout frames over the store for the workspaces frames replaced. A record
// equal to the store's keeps the store's object, so an unchanged frame re-renders nothing; a
// record the store already holds keeps what only this window knows about it (a terminal row's
// in-flight spawn and recovery state, an open file's editor state, a browser tab's page state).

import { BROWSER_TAB_LAYOUT_FIELDS } from '../../../shared/workspace-layout/workspace-layout-beside'
import { stableJson } from '../../../shared/workspace-layout/workspace-layout-load-report'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { AppState } from './types'
import type { LayoutFrameSlices } from './workspace-layout-frame-slices'

/** Row fields the save strips: they describe this window's mounted panes, never main's layout. */
const WINDOW_ONLY_TERMINAL_TAB_FIELDS = [
  'pendingActivationSpawn',
  'recovery',
  'restoredFromSession',
  'agentLaunchPane'
] as const satisfies readonly (keyof TerminalTab)[]

type KeyedSlice =
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'activeGroupIdByWorktree'
  | 'activeTabIdByWorktree'
  | 'activeFileIdByWorktree'
  | 'activeBrowserTabIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'browserTabsByWorktree'

export type LayoutFrameStoreState = Pick<
  AppState,
  KeyedSlice | 'terminalLayoutsByTabId' | 'openFiles' | 'browserPagesByWorkspace'
> &
  Pick<AppState, 'remoteBrowserPageHandlesByPageId'>

function same(a: unknown, b: unknown): boolean {
  return a === b || stableJson(a) === stableJson(b)
}

function withoutWindowOnlyFields(tab: TerminalTab): Partial<TerminalTab> {
  const fields: Partial<TerminalTab> = { ...tab }
  for (const field of WINDOW_ONLY_TERMINAL_TAB_FIELDS) {
    delete fields[field]
  }
  return fields
}

function mergeTerminalRow(existing: TerminalTab | undefined, built: TerminalTab): TerminalTab {
  if (!existing) {
    return built
  }
  if (same(withoutWindowOnlyFields(existing), built)) {
    return existing
  }
  const merged: TerminalTab = { ...built }
  for (const field of WINDOW_ONLY_TERMINAL_TAB_FIELDS) {
    if (existing[field] !== undefined) {
      Object.assign(merged, { [field]: existing[field] })
    }
  }
  return merged
}

/** Each built record, or the store's when equal; the store's array when every record is. */
function mergeById<T extends { id: string }>(
  existing: readonly T[] | undefined,
  built: readonly T[] | undefined,
  merge: (existing: T | undefined, built: T) => T = (current, next) =>
    current && same(current, next) ? current : next
): T[] | undefined {
  if (!built) {
    return undefined
  }
  const byId = new Map(existing?.map((record) => [record.id, record]))
  const merged = built.map((record) => merge(byId.get(record.id), record))
  return existing &&
    existing.length === merged.length &&
    merged.every((record, index) => record === existing[index])
    ? (existing as T[])
    : merged
}

const isEmpty = (value: unknown): boolean =>
  value === undefined || (Array.isArray(value) && value.length === 0)

function setKey<T>(
  map: Record<string, T>,
  key: string,
  value: T | undefined
): Record<string, T> | null {
  // A workspace with no records of a kind may be listed empty or left out; either reads the same.
  if (isEmpty(map[key]) && isEmpty(value)) {
    return null
  }
  if (map[key] === value || (value !== undefined && key in map && same(map[key], value))) {
    return null
  }
  if (value === undefined) {
    if (!(key in map)) {
      return null
    }
    const { [key]: _removed, ...rest } = map
    return rest
  }
  return { ...map, [key]: value }
}

/**
 * The store patch that shows `built` for `keys`; slices of other workspaces are untouched.
 * Returns only the slices that changed.
 */
export function buildLayoutFrameStorePatch(
  state: LayoutFrameStoreState,
  built: LayoutFrameSlices,
  keys: readonly string[]
): Partial<LayoutFrameStoreState> {
  const patch: Partial<LayoutFrameStoreState> = {}
  const keyed = (slice: KeyedSlice, value: (key: string) => unknown): void => {
    let next: Record<string, unknown> = state[slice]
    for (const key of keys) {
      next = setKey(next, key, value(key)) ?? next
    }
    if (next !== state[slice]) {
      Object.assign(patch, { [slice]: next })
    }
  }

  keyed('tabsByWorktree', (key) =>
    mergeById(state.tabsByWorktree[key], built.tabsByWorktree[key], mergeTerminalRow)
  )
  keyed('unifiedTabsByWorktree', (key) =>
    mergeById(state.unifiedTabsByWorktree[key], built.unifiedTabsByWorktree[key])
  )
  keyed('groupsByWorktree', (key) =>
    mergeById(state.groupsByWorktree[key], built.groupsByWorktree[key])
  )
  keyed('browserTabsByWorktree', (key) =>
    mergeById(
      state.browserTabsByWorktree[key],
      built.browserTabsByWorktree[key],
      (existing, next) => {
        if (!existing) {
          return next
        }
        const layoutFields = (tab: typeof next) =>
          BROWSER_TAB_LAYOUT_FIELDS.map((field) => tab[field])
        // Page state is this window's; main holds only the tab's own fields.
        return same(layoutFields(existing), layoutFields(next))
          ? existing
          : {
              ...existing,
              ...Object.fromEntries(BROWSER_TAB_LAYOUT_FIELDS.map((f) => [f, next[f]]))
            }
      }
    )
  )
  for (const slice of [
    'layoutByWorktree',
    'activeGroupIdByWorktree',
    'activeTabIdByWorktree',
    'activeFileIdByWorktree',
    'activeBrowserTabIdByWorktree',
    'activeTabTypeByWorktree'
  ] as const) {
    keyed(slice, (key) => built[slice][key])
  }

  const tabIdsOf = (tabs: Record<string, readonly TerminalTab[]>): Set<string> =>
    new Set(keys.flatMap((key) => (tabs[key] ?? []).map((tab) => tab.id)))
  let terminalLayouts = state.terminalLayoutsByTabId
  for (const tabId of new Set([
    ...tabIdsOf(state.tabsByWorktree),
    ...tabIdsOf(built.tabsByWorktree)
  ])) {
    terminalLayouts =
      setKey(terminalLayouts, tabId, built.terminalLayoutsByTabId[tabId]) ?? terminalLayouts
  }
  if (terminalLayouts !== state.terminalLayoutsByTabId) {
    patch.terminalLayoutsByTabId = terminalLayouts
  }

  const keySet = new Set(keys)
  const otherFiles = state.openFiles.filter((file) => !keySet.has(file.worktreeId))
  const ownFiles = state.openFiles.filter((file) => keySet.has(file.worktreeId))
  // An open file's editor state is this window's; a frame decides only which files are open.
  const files = mergeById(ownFiles, built.openFiles, (existing, next) => existing ?? next)
  if (files && files !== ownFiles) {
    patch.openFiles = [...otherFiles, ...files]
  }

  // Pages and handles are this window's; a frame only brings those of a tab it has not seen.
  const addMissing = <T>(current: Record<string, T>, incoming: Record<string, T>) => {
    const missing = Object.entries(incoming).filter(([id]) => !(id in current))
    return missing.length > 0 ? { ...current, ...Object.fromEntries(missing) } : null
  }
  const pages = addMissing(state.browserPagesByWorkspace, built.browserPagesByWorkspace)
  if (pages) {
    patch.browserPagesByWorkspace = pages
  }
  const handles = addMissing(
    state.remoteBrowserPageHandlesByPageId,
    built.remoteBrowserPageHandlesByPageId
  )
  if (handles) {
    patch.remoteBrowserPageHandlesByPageId = handles
  }
  return patch
}
