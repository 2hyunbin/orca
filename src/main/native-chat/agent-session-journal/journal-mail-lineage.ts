import type { AgentSessionRecord } from '../../../shared/agent-session-record'

export type MailLineageScope = { aliases: string[]; root: string | null }

export function mailLineageGraph(records: readonly AgentSessionRecord[]) {
  const ids = new Set(records.map((record) => record.sessionId))
  const edges = new Map<string, string[]>()
  const incoming = new Set<string>()
  for (const record of records) {
    const next = mailLineageValue(record)
    if (next) {
      for (const [from, to] of [
        [record.sessionId, next],
        [next, record.sessionId]
      ]) {
        const neighbors = edges.get(from) ?? []
        neighbors.push(to)
        edges.set(from, neighbors)
      }
      incoming.add(next)
    }
  }
  const graph = new Map<string, MailLineageScope | null>()
  for (const id of ids) {
    if (graph.has(id)) {
      continue
    }
    const aliases = [id],
      visited = new Set([id])
    let links = 0,
      valid = true
    for (let at = 0; at < aliases.length; at++) {
      const member = aliases[at]
      valid &&= ids.has(member)
      for (const neighbor of edges.get(member) ?? []) {
        links++
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          aliases.push(neighbor)
        }
      }
    }
    const roots = aliases.filter((member) => !incoming.has(member))
    const scope =
      valid && links / 2 < aliases.length
        ? { aliases, root: roots.length === 1 ? roots[0] : null }
        : null
    for (const member of aliases) {
      graph.set(member, scope)
    }
  }
  return graph
}
export function mailLineageValue(
  record: AgentSessionRecord | undefined
): string | null | undefined {
  if (!record) {
    return undefined
  }
  return record.conversationCommand?.command === 'clear' &&
    record.conversationCommand.phase === 'committed'
    ? (record.conversationCommand.replacementSessionId ?? null)
    : null
}
