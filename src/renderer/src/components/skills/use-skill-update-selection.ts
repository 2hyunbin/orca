import { useState } from 'react'
import type { SkillFreshnessGroupModel } from './skill-freshness-grouping'

export type SkillUpdateSelection = {
  checkboxFor: (name: string) => {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
  }
  reset: () => void
  selectedNames: string[]
  ownedCount: number
  unselectedForeignCount: number
}

/**
 * Which updatable skills the next run rewrites. Orca's own skills are preselected;
 * a same-named copy from elsewhere is only replaced once the user ticks it.
 */
export function useSkillUpdateSelection(
  groups: readonly SkillFreshnessGroupModel[]
): SkillUpdateSelection {
  // Why: null tracks Orca's own skills, so a re-scan re-derives it until the user ticks.
  const [override, setOverride] = useState<ReadonlySet<string> | null>(null)
  const updatable = groups.filter((group) => group.status === 'update-available')
  const owned = updatable.filter((group) => group.orcaOwned)
  const selected = override ?? new Set(owned.map((group) => group.name))
  return {
    checkboxFor: (name) => ({
      checked: selected.has(name),
      onCheckedChange: (checked) => {
        const next = new Set(selected)
        if (checked) {
          next.add(name)
        } else {
          next.delete(name)
        }
        setOverride(next)
      }
    }),
    reset: () => setOverride(null),
    selectedNames: updatable.filter((group) => selected.has(group.name)).map((group) => group.name),
    ownedCount: owned.length,
    unselectedForeignCount: updatable.filter(
      (group) => !group.orcaOwned && !selected.has(group.name)
    ).length
  }
}
