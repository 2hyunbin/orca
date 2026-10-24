import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'

/** Each pull examines one record or merges one entry; the background driver owns the yield. */
export function* orderedLegacyRestCandidates(
  store: Pick<AgentSessionRecordStore, 'iterateRecords' | 'getSessionTabId'>
): Generator<string | undefined> {
  let entries: { id: string; visible: boolean; updatedAt: number }[] = []
  for (const record of store.iterateRecords()) {
    entries.push({
      id: record.sessionId,
      visible: store.getSessionTabId(record.sessionId) !== null,
      updatedAt: record.updatedAt
    })
    yield undefined
  }
  for (let width = 1; width < entries.length; width *= 2) {
    const merged: typeof entries = []
    for (let start = 0; start < entries.length; start += 2 * width) {
      let left = start
      let right = Math.min(start + width, entries.length)
      const middle = right
      const end = Math.min(start + 2 * width, entries.length)
      while (left < middle || right < end) {
        const a = entries[left]
        const b = entries[right]
        const takeLeft =
          left < middle &&
          (right === end ||
            (Number(b.visible) - Number(a.visible) || b.updatedAt - a.updatedAt) <= 0)
        merged.push(entries[takeLeft ? left++ : right++])
        yield undefined
      }
    }
    entries = merged
  }
  for (const entry of entries) {
    yield entry.id
  }
}
