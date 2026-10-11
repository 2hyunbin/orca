import { useMemo, useState } from 'react'
import type { SkillFreshnessInventory } from '../../../../shared/skill-freshness'
import { orcaOwnedSkillNames } from './skill-freshness-grouping'

export type SkillUpdateSelection = {
  checkboxFor: (name: string) => {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
  }
  reset: () => void
  /** Live eligible names the user selected; the only names an update may fire. */
  selectedNames: string[]
  /** The same count over the retained inventory, so the button holds through a re-scan. */
  displaySelectedCount: number
  ownedEligibleCount: number
  unselectedForeignCount: number
}

/**
 * Which outdated skills the next update rewrites. Orca's own skills are preselected;
 * a same-named copy from elsewhere is only replaced once the user ticks it.
 */
export function useSkillUpdateSelection(
  liveInventory: SkillFreshnessInventory | null,
  displayInventory: SkillFreshnessInventory | null
): SkillUpdateSelection {
  // Why: null tracks Orca's own skills, so a re-scan re-derives it until the user ticks.
  const [override, setOverride] = useState<ReadonlySet<string> | null>(null)
  const liveEligible = liveInventory?.eligibleUpdateNames ?? []
  const displayEligible = displayInventory?.eligibleUpdateNames ?? []
  const defaultSelection = useMemo(() => {
    const owned = orcaOwnedSkillNames(displayInventory?.installations ?? [])
    return new Set((displayInventory?.eligibleUpdateNames ?? []).filter((name) => owned.has(name)))
  }, [displayInventory])
  const liveOwned = useMemo(
    () => orcaOwnedSkillNames(liveInventory?.installations ?? []),
    [liveInventory]
  )
  const selection = override ?? defaultSelection
  return {
    checkboxFor: (name) => ({
      checked: selection.has(name),
      onCheckedChange: (checked) =>
        setOverride((previous) => {
          const next = new Set(previous ?? defaultSelection)
          if (checked) {
            next.add(name)
          } else {
            next.delete(name)
          }
          return next
        })
    }),
    reset: () => setOverride(null),
    selectedNames: liveEligible.filter((name) => selection.has(name)),
    displaySelectedCount: displayEligible.filter((name) => selection.has(name)).length,
    ownedEligibleCount: liveEligible.filter((name) => liveOwned.has(name)).length,
    unselectedForeignCount: liveEligible.filter(
      (name) => !liveOwned.has(name) && !selection.has(name)
    ).length
  }
}
