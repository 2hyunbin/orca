/** Human title from a dotted plugin key (`example.worktree-notes` → `Worktree Notes`). */
export function pluginDisplayNameFromKey(pluginKey: string): string {
  return pluginKey
    .split('.')
    .at(-1)!
    .split(/[-_]+/)
    .map((word) =>
      word.toLowerCase() === 'orca' ? 'Orca' : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`
    )
    .join(' ')
}

/** One- or two-letter monogram for plugin avatar tiles. */
export function pluginMonogram(name: string): string {
  const parts = name
    .trim()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const first = parts[0]
  const second = parts[1]
  if (!first) {
    return '?'
  }
  if (!second) {
    return Array.from(first).slice(0, 2).join('').toUpperCase()
  }
  return `${Array.from(first)[0] ?? ''}${Array.from(second)[0] ?? ''}`.toUpperCase()
}
