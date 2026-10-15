import {
  SUPPORTED_GLOBAL_SKILL_TOPOLOGIES,
  type SkillFreshnessInstallation,
  type SkillInstallationTopology
} from '../../shared/skill-freshness'

// Why: writing through a link out of tree touches someone else's files (#22897), and a
// read-only or dangling placement fails half-way. Any such home placement keeps the name skipped.
const UNWRITABLE_HOME_TOPOLOGIES: ReadonlySet<SkillInstallationTopology> = new Set([
  'external-link',
  'broken-link',
  'read-only'
])

/**
 * Names the bundled install can safely bring to this build's version.
 *
 * Ownership is deliberately not consulted: whether to preselect a copy someone else
 * installed is presentation policy. Copies the command never writes (project skills,
 * plugin caches) neither authorize an update nor withhold one.
 */
export function eligibleSkillUpdateNames(
  installations: readonly SkillFreshnessInstallation[]
): string[] {
  const byName = new Map<string, SkillFreshnessInstallation[]>()
  for (const installation of installations) {
    const entries = byName.get(installation.name) ?? []
    entries.push(installation)
    byName.set(installation.name, entries)
  }

  const eligible: string[] = []
  for (const [name, entries] of byName) {
    const convergent = entries.filter((entry) =>
      SUPPORTED_GLOBAL_SKILL_TOPOLOGIES.has(entry.topology)
    )
    if (
      convergent.some((entry) => entry.status === 'outdated') &&
      convergent.every((entry) => entry.status !== 'inaccessible') &&
      entries.every((entry) => !UNWRITABLE_HOME_TOPOLOGIES.has(entry.topology))
    ) {
      eligible.push(name)
    }
  }
  return eligible.sort((left, right) => left.localeCompare(right, 'en'))
}
