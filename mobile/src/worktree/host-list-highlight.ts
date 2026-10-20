import { parseExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import type { Section, Worktree } from './workspace-list-types'

// Kept free of storage and React Native: the e2e phone-list helper builds sections through this.

/** The workspace this phone last opened on one paired host: the session route's own params. */
export type LastVisitedWorktreeOnHost = {
  worktreeId: string
  /** A server workspace's `runtime:` host; absent for the desktop's own (local and SSH) rows. */
  executionHost?: ExecutionHostId
}

/** Undefined while the stored visit is read; null when this phone has opened nothing on the host. */
export type HostVisit = LastVisitedWorktreeOnHost | null | undefined

/** The route's server for a row, as the host list routes it: only a `runtime:` host is named. */
export function routeExecutionHostOf(
  hostId: string | null | undefined
): ExecutionHostId | undefined {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime' ? parsed.id : undefined
}

/** Whether `row` is the workspace this phone last opened on its host. */
export function isLastVisitedWorktreeRow(
  row: Pick<Worktree, 'worktreeId' | 'hostId'>,
  visited: LastVisitedWorktreeOnHost | null
): boolean {
  return (
    visited !== null &&
    row.worktreeId === visited.worktreeId &&
    routeExecutionHostOf(row.hostId) === visited.executionHost
  )
}

/**
 * The host list's highlight over the rows as shown, which arrive marked with the desktop's
 * selection: this phone's last-opened workspace where it is shown, else the desktop's selection,
 * and nothing while the phone's visit is still being read.
 */
export function highlightPhoneVisit(sections: Section[], visit: HostVisit): Section[] {
  if (visit === null) {
    return sections
  }
  const shown =
    visit !== undefined &&
    sections.some((section) => section.data.some((row) => isLastVisitedWorktreeRow(row, visit)))
  if (visit !== undefined && !shown) {
    return sections
  }
  return sections.map((section) => ({
    ...section,
    data: section.data.map((row) => ({
      ...row,
      isActive: visit !== undefined && isLastVisitedWorktreeRow(row, visit)
    }))
  }))
}
