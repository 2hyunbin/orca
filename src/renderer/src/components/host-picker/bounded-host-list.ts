// Why: a generated ~/.ssh/config can import >10k hosts; a row each made one list cost GBs of DOM.
export const HOST_LIST_ROW_LIMIT = 50

export type BoundedHostList<T> = {
  shown: T[]
  /** Hosts matching the query that the limit left out. */
  hiddenCount: number
}

/**
 * The one choke point for drawing a list of hosts. Pinned hosts (current value, checked or muted
 * ones) always show so state is never hidden; the rest are narrowed by `query` and capped. Matches
 * rank exact names, then prefixes, then substrings (of the label or `searchText`), so typing a host's
 * full name always reaches it.
 */
export function boundHostList<T extends { id: string; label: string; searchText?: string }>(
  hosts: readonly T[],
  options: { query?: string; pinnedIds?: ReadonlySet<string>; limit?: number } = {}
): BoundedHostList<T> {
  const { pinnedIds, limit = HOST_LIST_ROW_LIMIT } = options
  const needle = (options.query ?? '').trim().toLowerCase()
  const pinned: T[] = []
  const exact: T[] = []
  const prefix: T[] = []
  const contains: T[] = []
  for (const host of hosts) {
    if (pinnedIds?.has(host.id)) {
      pinned.push(host)
      continue
    }
    const label = host.label.toLowerCase()
    if (label === needle) {
      exact.push(host)
    } else if (label.startsWith(needle)) {
      prefix.push(host)
    } else if (label.includes(needle) || host.searchText?.toLowerCase().includes(needle)) {
      contains.push(host)
    }
  }
  const matches = [...exact, ...prefix, ...contains]
  const room = Math.max(0, limit - pinned.length)
  return {
    shown: [...pinned, ...matches.slice(0, room)],
    hiddenCount: Math.max(0, matches.length - room)
  }
}
