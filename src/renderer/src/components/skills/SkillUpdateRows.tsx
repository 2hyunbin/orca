import { ChevronDown, ChevronUp } from 'lucide-react'
import type {
  BundledSkillOutcomeSummary,
  BundledSkillPlanSkillSummary,
  BundledSkillPlanState
} from '../../../../shared/bundled-skill-summary'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SkillUpdateRow, type SkillReplaceToggle, type SkillRowPhase } from './SkillUpdateRow'

// Why: what Update changes reads first, then what it leaves for the user.
const ROW_ORDER: readonly BundledSkillPlanState[] = [
  'repair',
  'update',
  'install',
  'attention',
  'current'
]

/** A finished run lists what it changed and what it left; untouched skills stay off. */
function resultShowsRow(outcome: BundledSkillOutcomeSummary | undefined): boolean {
  return Boolean(outcome && (outcome.text !== 'No change' || outcome.leftAlone.length > 0))
}

function UpToDateLine({
  skills
}: {
  skills: readonly BundledSkillPlanSkillSummary[]
}): React.JSX.Element | null {
  const upToDate = skills.filter((skill) => skill.upToDate)
  if (upToDate.length === 0) {
    return null
  }
  return (
    <p className="text-xs text-muted-foreground">
      {upToDate.length === 1
        ? translate(
            'auto.components.skills.SkillFreshnessUpdateDialog.upToDateOne',
            '{{value0}} is up to date.',
            { value0: upToDate[0].name }
          )
        : translate(
            'auto.components.skills.SkillFreshnessUpdateDialog.upToDateMany',
            '{{value0}} skills are up to date.',
            { value0: upToDate.length }
          )}
    </p>
  )
}

/** The skill rows plus, while reviewing, the up-to-date line and the locations toggle. */
export function SkillUpdateRows({
  skills,
  phase,
  outcomes,
  replace,
  showLocations,
  onToggleLocations
}: {
  skills: readonly BundledSkillPlanSkillSummary[]
  phase: SkillRowPhase
  outcomes: ReadonlyMap<string, BundledSkillOutcomeSummary>
  replace: SkillReplaceToggle
  showLocations: boolean
  onToggleLocations: () => void
}): React.JSX.Element {
  // Why: a result re-plans every skill as current, so it orders by what the run did instead.
  const rowRank = (skill: BundledSkillPlanSkillSummary): number =>
    phase === 'result'
      ? outcomes.get(skill.name)?.text === 'No change'
        ? 1
        : 0
      : ROW_ORDER.indexOf(skill.state)
  return (
    <div className="min-w-0 border-t border-border/60">
      <TooltipProvider>
        {[...skills]
          .sort((left, right) => rowRank(left) - rowRank(right))
          .filter((skill) =>
            phase === 'result'
              ? resultShowsRow(outcomes.get(skill.name))
              : showLocations || !skill.upToDate
          )
          .map((skill) => (
            <SkillUpdateRow
              key={skill.name}
              skill={skill}
              phase={phase}
              outcome={outcomes.get(skill.name)}
              replace={replace}
              showLocations={showLocations && phase !== 'result'}
            />
          ))}
      </TooltipProvider>
      {phase === 'plan' ? (
        <div className="flex flex-col items-start gap-1 pt-2.5">
          {!showLocations ? <UpToDateLine skills={skills} /> : null}
          <Button
            type="button"
            variant="link"
            size="xs"
            className="-ml-2"
            onClick={onToggleLocations}
          >
            {showLocations
              ? translate(
                  'auto.components.skills.SkillFreshnessUpdateDialog.hideLocations',
                  'Hide locations'
                )
              : translate(
                  'auto.components.skills.SkillFreshnessUpdateDialog.showLocations',
                  'Show all locations'
                )}
            {showLocations ? <ChevronUp /> : <ChevronDown />}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
