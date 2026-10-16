// A layout-owner build's check that the window's session saves no longer carry layout: every tab
// change should reach main as a command, so a save that changes main's published layout is a
// change main learned only from the save. Dark: reports only, never alters the write.

import { appendFileSync } from 'node:fs'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { loadWorkspaceLayoutWithoutReport } from '../../shared/workspace-layout/workspace-layout-load'
import { stableJson } from '../../shared/workspace-layout/workspace-layout-load-report'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/** Set by evidence runs: each divergence is appended there as one JSON line. */
const LOG_PATH_ENV = 'ORCA_LAYOUT_SAVE_DIVERGENCE_LOG'
const MAX_PATHS = 12

export type WindowSaveDivergence = { workspace: string; paths: string[] }

export function publishedLayouts(
  session: WorkspaceSessionState | null | undefined,
  hostId: ExecutionHostId
): Map<string, PublishedWorkspaceLayout> {
  const result = new Map<string, PublishedWorkspaceLayout>()
  if (!session) {
    return result
  }
  const { layout } = loadWorkspaceLayoutWithoutReport(hostId, session, nameBasedLoadContext())
  for (const [key, workspace] of Object.entries(layout.workspaces)) {
    result.set(key, publishWorkspaceLayout(workspace, hostId))
  }
  return result
}

function byId<T extends object>(items: readonly T[], id: (item: T) => string): Map<string, T> {
  return new Map(items.map((item) => [id(item), item]))
}

/** The fields two copies of one record differ in. */
function changedFields(before: object, after: object): string[] {
  const was = new Map(Object.entries(before))
  const now = new Map(Object.entries(after))
  return [...new Set([...was.keys(), ...now.keys()])].filter(
    (key) => stableJson(was.get(key) ?? null) !== stableJson(now.get(key) ?? null)
  )
}

function diffById<T extends object>(
  prefix: string,
  before: Map<string, T>,
  after: Map<string, T>
): string[] {
  const paths: string[] = []
  for (const [id, item] of after) {
    const old = before.get(id)
    if (old === undefined) {
      paths.push(`${prefix} ${id} added`)
      continue
    }
    const fields = changedFields(old, item)
    if (fields.length > 0) {
      paths.push(`${prefix} ${id} changed: ${fields.join(', ')}`)
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id)) {
      paths.push(`${prefix} ${id} removed`)
    }
  }
  return paths
}

/** What a save changed in one workspace's published layout, as short paths; empty when nothing. */
export function diffPublishedLayouts(
  before: PublishedWorkspaceLayout | undefined,
  after: PublishedWorkspaceLayout | undefined
): string[] {
  if (!before || !after) {
    return before === after ? [] : [after ? 'workspace added' : 'workspace removed']
  }
  const paths = [
    ...diffById(
      'group',
      byId(before.groups, (g) => g.id),
      byId(after.groups, (g) => g.id)
    ),
    ...diffById(
      'tab',
      byId(before.tabs, (t) => t.id),
      byId(after.tabs, (t) => t.id)
    ),
    ...diffById(
      'file',
      byId(before.editorFiles, (f) => f.filePath),
      byId(after.editorFiles, (f) => f.filePath)
    ),
    ...diffById(
      'browser',
      byId(before.browserTabs, (b) => b.id),
      byId(after.browserTabs, (b) => b.id)
    )
  ]
  if (stableJson(before.groupLayout ?? null) !== stableJson(after.groupLayout ?? null)) {
    paths.push('group layout changed')
  }
  // Same members, another order: the one tab order moved.
  if (
    paths.length === 0 &&
    stableJson(before.tabs.map((t) => t.id)) !== stableJson(after.tabs.map((t) => t.id))
  ) {
    paths.push('tab order changed')
  }
  return paths
}

/** Each workspace whose published layout differs between two projections of one partition. */
export function windowSaveDivergences(
  was: Map<string, PublishedWorkspaceLayout>,
  now: Map<string, PublishedWorkspaceLayout>
): WindowSaveDivergence[] {
  const result: WindowSaveDivergence[] = []
  for (const workspace of new Set([...was.keys(), ...now.keys()])) {
    const paths = diffPublishedLayouts(was.get(workspace), now.get(workspace))
    if (paths.length > 0) {
      result.push({ workspace, paths: paths.slice(0, MAX_PATHS) })
    }
  }
  return result
}

/**
 * Runs the window's save `write` and reports what it changed in main's published layout. A paired
 * server's partition is skipped: its layout is the server's, mirrored by the window.
 */
export function writeWindowSaveWatchingLayout(
  read: () => WorkspaceSessionState | null | undefined,
  hostId: string | null | undefined,
  write: () => void,
  source: string
): void {
  const partition = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  if (parseExecutionHostId(partition)?.kind === 'runtime') {
    write()
    return
  }
  const project = (): Map<string, PublishedWorkspaceLayout> | null => {
    try {
      return publishedLayouts(read(), partition)
    } catch (error) {
      console.warn('[layout-owner] save divergence check failed:', error)
      return null
    }
  }
  const was = project()
  write()
  const now = was && project()
  if (!was || !now) {
    return
  }
  for (const divergence of windowSaveDivergences(was, now)) {
    console.warn('[layout-owner] window save changed main layout:', source, divergence)
    const logPath = process.env[LOG_PATH_ENV]
    if (logPath) {
      appendFileSync(
        logPath,
        `${JSON.stringify({ at: Date.now(), source, partition, ...divergence })}\n`
      )
    }
  }
}
