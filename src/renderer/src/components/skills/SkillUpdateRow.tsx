import { AlertTriangle, CheckCircle2, ChevronDown, Circle, XCircle } from 'lucide-react'
import type {
  BundledSkillOp,
  BundledSkillOutcome,
  BundledSkillPlanEntry
} from '../../../../shared/bundled-skill-plan'
import {
  bundledSkillInstallAgents,
  bundledSkillPlanState,
  summarizeBundledSkillOutcome,
  type BundledSkillPlanState
} from '../../../../shared/bundled-skill-summary'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  installForAgentsLabel,
  leaveReasonText,
  opOutcomeLabel,
  planOpLabel,
  skillOutcomeLine
} from './skill-plan-op-copy'

export type SkillRowPhase = 'plan' | 'pending' | 'result'

export type SkillReplaceToggle = {
  isReplaced: (path: string) => boolean
  onReplaceChange: (path: string, replace: boolean) => void
}

function ResultIcon({ outcome }: { outcome: BundledSkillOutcome }): React.JSX.Element {
  const summary = summarizeBundledSkillOutcome(outcome)
  if (summary.text === 'Needs attention') {
    return <XCircle className="size-4 shrink-0 text-destructive" />
  }
  return summary.leftAlone.length > 0 ? (
    <AlertTriangle className="size-4 shrink-0 text-status-warning" />
  ) : (
    <CheckCircle2 className="size-4 shrink-0 text-status-success" />
  )
}

/** Sits immediately right of the name, so the label reads as part of it. */
function PlanBadge({
  state,
  entry
}: {
  state: BundledSkillPlanState
  entry: BundledSkillPlanEntry
}): React.JSX.Element | null {
  switch (state) {
    case 'current':
      return null
    case 'update':
      return (
        <Badge variant="secondary" className="shrink-0">
          {translate(
            'auto.components.skills.SkillFreshnessRow.statusUpdateAvailable',
            'Update available'
          )}
        </Badge>
      )
    case 'install': {
      const label = installForAgentsLabel(bundledSkillInstallAgents([entry]))
      return (
        // Why truncate: one skill can link into many agents, and the name must stay visible.
        <Badge variant="secondary" className="min-w-0 shrink" title={label}>
          <span className="truncate">{label}</span>
        </Badge>
      )
    }
    case 'repair':
    case 'attention':
      return (
        <Badge
          variant="outline"
          className="shrink-0 border-amber-600/50 text-amber-700 dark:border-amber-400/40 dark:text-amber-400"
        >
          {state === 'repair'
            ? translate('auto.components.skills.skillPlanOpCopy.restore', 'Needs repair')
            : translate('auto.components.skills.SkillUpdateRow.leftAlone', 'Left alone')}
        </Badge>
      )
  }
}

function isReplaceable(op: BundledSkillOp): boolean {
  return (op.kind === 'leave' && op.replaceable === true) || op.kind === 'replace'
}

/**
 * One skill in the update dialog, in every phase. The header keeps its geometry from plan
 * through result; locations sit behind a disclosure so a skill linked into several agents
 * does not bury the actions.
 */
export function SkillUpdateRow({
  entry,
  phase,
  outcome,
  replace
}: {
  entry: BundledSkillPlanEntry
  phase: SkillRowPhase
  outcome?: BundledSkillOutcome
  /** Present only while the user is reviewing the plan. */
  replace?: SkillReplaceToggle
}): React.JSX.Element {
  const state = bundledSkillPlanState(entry)
  const outcomeByPath = new Map(outcome?.ops.map((op) => [op.path, op]))
  // Why outside the disclosure: why a copy is left alone must not depend on a click.
  const leaveReasons =
    phase === 'plan'
      ? [
          ...new Set(
            entry.ops.flatMap((op) => (op.kind === 'leave' ? [leaveReasonText(op.reason)] : []))
          )
        ]
      : []
  return (
    <Collapsible
      data-skill-row={entry.name}
      data-state-label={phase === 'result' && outcome ? 'result' : state}
      // Why open: the Replace choice for a copy left alone must be in view, not one click away.
      defaultOpen={phase === 'plan' && entry.ops.some(isReplaceable)}
      className="-mx-1.5 border-t border-border/60 py-0.5 first:border-t-0"
    >
      <div
        className={cn(
          'flex min-w-0 items-center transition-opacity',
          phase === 'pending' && 'opacity-60'
        )}
      >
        <CollapsibleTrigger variant="row" className="min-w-0">
          <span className="ml-1.5 flex min-w-0 flex-1 items-center gap-2">
            {phase === 'pending' ? (
              <Circle className="size-4 shrink-0 text-muted-foreground" />
            ) : null}
            {phase === 'result' && outcome ? <ResultIcon outcome={outcome} /> : null}
            <span className="shrink-0 text-[13px] font-medium text-foreground">{entry.name}</span>
            {phase === 'plan' ? <PlanBadge state={state} entry={entry} /> : null}
          </span>
          <span className="shrink-0 text-[11px] font-normal tabular-nums text-muted-foreground">
            {entry.ops.length === 1
              ? translate('auto.components.skills.SkillUpdateRow.oneLocation', '1 location')
              : translate(
                  'auto.components.skills.SkillUpdateRow.manyLocations',
                  '{{value0}} locations',
                  { value0: entry.ops.length }
                )}
          </span>
          <ChevronDown className="mr-1.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
      </div>

      {phase === 'result' && outcome ? (
        <p className="px-1.5 pb-1.5 text-xs leading-5 text-muted-foreground">
          {skillOutcomeLine(summarizeBundledSkillOutcome(outcome))}
        </p>
      ) : null}
      {leaveReasons.map((reason) => (
        <p key={reason} className="px-1.5 pb-1.5 text-xs leading-5 text-muted-foreground">
          {reason}
        </p>
      ))}

      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        <div className="flex flex-col gap-2 px-1.5 pb-2 pt-0.5">
          {entry.ops.map((op) => {
            const opOutcome = outcomeByPath.get(op.path)
            return (
              <div key={op.path} className="flex min-w-0 items-center gap-2">
                {/* Why: without a shrink basis a long path sets the dialog's width. */}
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
                  title={op.path}
                >
                  {op.path}
                </span>
                <Badge variant="outline" className="shrink-0">
                  {phase === 'result' && opOutcome ? opOutcomeLabel(opOutcome) : planOpLabel(op)}
                </Badge>
                {replace && isReplaceable(op) ? (
                  <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Checkbox
                      checked={replace.isReplaced(op.path)}
                      onCheckedChange={(checked) =>
                        replace.onReplaceChange(op.path, checked === true)
                      }
                    />
                    {translate('auto.components.skills.SkillUpdateRow.replace', 'Replace')}
                  </label>
                ) : null}
              </div>
            )
          })}
          {replace && entry.ops.some(isReplaceable) ? (
            <p className="text-[11px] leading-4 text-muted-foreground">
              {translate(
                'auto.components.skills.SkillUpdateRow.replaceHint',
                'Replace moves that copy to a backup, then puts Orca’s copy in its place.'
              )}
            </p>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
