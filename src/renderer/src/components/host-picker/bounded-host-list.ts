// Why: a generated ~/.ssh/config can import >10k hosts; a row each made one list cost GBs of DOM.
export const HOST_LIST_ROW_LIMIT = 50

export type BoundedHostList<T> = {
  shown: T[]
  /** Hosts matching the query that the limits left out. */
  hiddenCount: number
}

type MatchRank = 'exact' | 'prefix' | 'contains' | null

function rankHost(host: { label: string; searchText?: string }, needle: string): MatchRank {
  const label = host.label.toLowerCase()
  if (label === needle) {
    return 'exact'
  }
  if (label.startsWith(needle)) {
    return 'prefix'
  }
  if (label.includes(needle) || host.searchText?.toLowerCase().includes(needle)) {
    return 'contains'
  }
  return null
}

/**
 * The one choke point for drawing a list of hosts. Pinned hosts (current value, checked or muted
 * ones) come first so state stays visible; the rest are ranked by `query`: exact names, then
 * prefixes, then substrings (of the label or `searchText`). Pinned and other matches each get
 * their own `limit`, so a long pinned set never crowds out what the user is searching for, and
 * typing a host's full name always reaches it.
 */
export function boundHostList<T extends { id: string; label: string; searchText?: string }>(
  hosts: readonly T[],
  options: { query?: string; pinnedIds?: ReadonlySet<string>; limit?: number } = {}
): BoundedHostList<T> {
  const { pinnedIds, limit = HOST_LIST_ROW_LIMIT } = options
  const needle = (options.query ?? '').trim().toLowerCase()
  const pinned: T[] = []
  const ranked: Record<Exclude<MatchRank, null>, T[]> = { exact: [], prefix: [], contains: [] }
  for (const host of hosts) {
    const rank = rankHost(host, needle)
    if (rank === null) {
      continue
    }
    if (pinnedIds?.has(host.id)) {
      pinned.push(host)
    } else {
      ranked[rank].push(host)
    }
  }
  const matches = [...ranked.exact, ...ranked.prefix, ...ranked.contains]
  return {
    shown: [...pinned.slice(0, limit), ...matches.slice(0, limit)],
    hiddenCount: Math.max(0, pinned.length - limit) + Math.max(0, matches.length - limit)
  }
}
