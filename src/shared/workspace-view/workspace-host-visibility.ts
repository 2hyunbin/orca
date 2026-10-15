import type { ExecutionHostId } from '../execution-host'
import {
  expandEquivalentExecutionHostIds,
  pickerExecutionHosts,
  type MergedExecutionHost
} from '../managed-orcad-execution-host'

// The Workspace options "Hosts" checklist, shared so the phone toggles hosts as the desktop does.

/** Picker rows a saved visibility list selects; a row counts when any id it stands for is saved. */
export function getCheckedHostRows<T extends MergedExecutionHost>(
  rows: readonly T[],
  visibleHostIds: readonly ExecutionHostId[]
): T[] {
  const visible = new Set(visibleHostIds)
  return rows.filter(
    (row) => visible.has(row.id) || (row.aliasHostIds ?? []).some((id) => visible.has(id))
  )
}

/**
 * The visibility list after toggling one picker row, or undefined when the toggle is refused (the
 * last checked row). A row writes every id it stands for, so exact-id filters match both owners.
 */
export function toggleVisibleHostRow(
  hosts: readonly MergedExecutionHost[],
  visibleHostIds: readonly ExecutionHostId[] | null,
  row: MergedExecutionHost
): ExecutionHostId[] | null | undefined {
  const rowIds = expandEquivalentExecutionHostIds(hosts, [row.id])
  if (!visibleHostIds) {
    return rowIds
  }
  const rows = pickerExecutionHosts(hosts)
  const checkedRows = getCheckedHostRows(rows, visibleHostIds)
  const next = new Set(visibleHostIds)
  if (checkedRows.some((checked) => checked.id === row.id)) {
    if (checkedRows.length <= 1) {
      return undefined
    }
    rowIds.forEach((id) => next.delete(id))
  } else {
    rowIds.forEach((id) => next.add(id))
  }
  return getCheckedHostRows(rows, [...next]).length === rows.length ? null : [...next]
}

/** "All hosts": shows every host, or when it already does, narrows to the first row. */
export function toggleAllVisibleHosts(
  hosts: readonly MergedExecutionHost[],
  visibleHostIds: readonly ExecutionHostId[] | null
): ExecutionHostId[] | null | undefined {
  if (visibleHostIds) {
    return null
  }
  const firstHost = pickerExecutionHosts(hosts)[0]
  return firstHost ? expandEquivalentExecutionHostIds(hosts, [firstHost.id]) : undefined
}
