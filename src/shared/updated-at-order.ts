/** Sorts in place; invalid dates retain the native comparator's stable tie behavior. */
export function sortByUpdatedAtDescending<T extends { updatedAt: string | null }>(
  items: T[],
  readTimestamp: (item: T) => number = (item) => new Date(item.updatedAt ?? '').getTime()
): T[] {
  if (items.length < 2) {
    return items
  }
  const timestamps = new Map<T, number>()
  for (const item of items) {
    timestamps.set(item, readTimestamp(item))
  }
  return items.sort((left, right) => timestamps.get(right)! - timestamps.get(left)!)
}
