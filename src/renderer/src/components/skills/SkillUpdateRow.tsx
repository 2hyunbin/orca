import type { BundledSkillLocation } from '../../../../shared/bundled-skill-locations'
import type {
  BundledSkillOutcomeSummary,
  BundledSkillPlanSkillSummary
} from '../../../../shared/bundled-skill-summary'
import { translate } from '@/i18n/i18n'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  leaveReasonText,
  locationPlaceLabel,
  locationStateText,
  skillOutcomeText,
  skillPlanHeadline
} from './skill-plan-op-copy'

export type SkillRowPhase = 'plan' | 'pending' | 'result'

export type SkillReplaceToggle = {
  isReplaced: (path: string) => boolean
  onReplaceChange: (path: string, replace: boolean) => void
}

/** The place, with the full path on hover; "Show all locations" lists it for keyboard users. */
function PlaceLabel({ location }: { location: BundledSkillLocation }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help text-muted-foreground underline decoration-dotted underline-offset-2">
          {locationPlaceLabel(location)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm [overflow-wrap:anywhere]">
        <span className="font-mono">{location.path}</span>
      </TooltipContent>
    </Tooltip>
  )
}

/** A location Update leaves alone, or one the user chose to Replace. */
function ChoiceLine({
  location,
  replace
}: {
  location: BundledSkillLocation
  replace?: SkillReplaceToggle
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <PlaceLabel location={location} />
        {': '}
        {location.state === 'replace'
          ? locationStateText(location)
          : leaveReasonText(location.reason)}
      </span>
      {replace && location.replaceable ? (
        <label className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox
            checked={replace.isReplaced(location.path)}
            onCheckedChange={(checked) => replace.onReplaceChange(location.path, checked === true)}
          />
          {translate(
            'auto.components.skills.SkillUpdateRow.replaceWithOrca',
            "Replace with Orca's copy (keeps a backup)"
          )}
        </label>
      ) : null}
    </div>
  )
}

function LocationTable({
  locations
}: {
  locations: readonly BundledSkillLocation[]
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 px-3 py-2">
      {locations.map((location) => (
        // Why the state sits under the path: a long reason must not squeeze the path to "~/…".
        <div
          key={location.path}
          className="grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-x-2 text-xs"
        >
          <span className="truncate text-foreground">{locationPlaceLabel(location)}</span>
          <span className="flex min-w-0 flex-col">
            <span
              className="truncate font-mono text-[11px] text-muted-foreground"
              title={location.path}
            >
              {location.displayPath}
            </span>
            <span className="text-muted-foreground">{locationStateText(location)}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * One skill in the update dialog: what Update does to it, the locations it leaves for the
 * user (named by agent, path on hover) and, on request, every location it planned.
 */
export function SkillUpdateRow({
  skill,
  phase,
  outcome,
  replace,
  showLocations
}: {
  skill: BundledSkillPlanSkillSummary
  phase: SkillRowPhase
  outcome?: BundledSkillOutcomeSummary
  replace?: SkillReplaceToggle
  showLocations: boolean
}): React.JSX.Element {
  const headline =
    phase === 'pending'
      ? translate('auto.components.skills.SkillFreshnessUpdateDialog.updating', 'Updating…')
      : phase === 'result' && outcome
        ? // Why: a skill the run only reports on shows its left-alone lines, not "No change".
          outcome.text === 'No change' && outcome.leftAlone.length > 0
          ? null
          : skillOutcomeText(outcome.text)
        : skillPlanHeadline(skill.state)
  const choices = skill.locations.filter(
    (location) => location.state === 'leave' || location.state === 'replace'
  )
  return (
    <div
      data-skill-row={skill.name}
      data-state-label={phase === 'plan' ? skill.state : phase}
      className="grid grid-cols-[8rem_minmax(0,1fr)] items-start gap-x-3 border-b border-border/60 py-2.5 text-[13px] last:border-b-0"
    >
      <span className="truncate font-medium text-foreground" title={skill.name}>
        {skill.name}
      </span>
      <div className="flex min-w-0 flex-col gap-1.5 text-foreground">
        {headline ? <span>{headline}</span> : null}
        {choices.map((location) => (
          <ChoiceLine key={location.path} location={location} {...(replace ? { replace } : {})} />
        ))}
        {showLocations ? <LocationTable locations={skill.locations} /> : null}
      </div>
    </div>
  )
}
