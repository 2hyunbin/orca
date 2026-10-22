import { useState, useSyncExternalStore } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import type { BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import {
  summarizeBundledSkillPlan,
  type BundledSkillOutcomeSummary
} from '../../../../shared/bundled-skill-summary'
import { useSkillFreshness } from '@/hooks/useSkillFreshness'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { bundledSkillTargetKey } from '@/lib/bundled-skill-target'
import type { BundledSkillUnsupportedReason } from '@/runtime/runtime-bundled-skills-client'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { SkillRowPhase } from './SkillUpdateRow'
import { SkillUpdateRows } from './SkillUpdateRows'
import { SummaryHeadline } from './skill-freshness-summary-headline'
import { updateActionLabel } from './skill-plan-op-copy'
import {
  acknowledgeLatestSkillUpdateRun,
  acknowledgeSkillUpdateRun,
  startSkillUpdateRun,
  useSkillUpdateRun,
  type SkillUpdateRun
} from './skill-update-run-store'
import {
  consumeSkillFreshnessUpdateDialogRequest,
  getSkillFreshnessUpdateDialogRequest,
  subscribeSkillFreshnessUpdateDialog
} from './skill-freshness-update-dialog'
import { useReviewedSkillPlan } from './use-reviewed-skill-plan'

function RunHeadline({ run }: { run: SkillUpdateRun }): React.JSX.Element | null {
  if (run.state === 'running') {
    return (
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        {translate(
          'auto.components.skills.SkillFreshnessUpdateDialog.progressAria',
          'Updating skills'
        )}
      </div>
    )
  }
  if (run.state === 'done' && run.summary.ok) {
    const { changedCount, leftAloneCount } = run.summary
    const updated =
      changedCount === 1
        ? translate(
            'auto.components.skills.SkillFreshnessUpdateDialog.updatedOne',
            'Updated 1 skill'
          )
        : translate(
            'auto.components.skills.SkillFreshnessUpdateDialog.updatedMany',
            'Updated {{value0}} skills',
            { value0: changedCount }
          )
    return (
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <CheckCircle2 className="size-4 text-status-success" />
        {leftAloneCount > 0
          ? translate(
              'auto.components.skills.SkillFreshnessUpdateDialog.updatedLeftAlone',
              '{{value0}} · {{value1}} left alone',
              { value0: updated, value1: leftAloneCount }
            )
          : updated}
      </div>
    )
  }
  if (run.state === 'done') {
    return (
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400" />
        {translate(
          'auto.components.skills.SkillFreshnessUpdateDialog.finishedWithProblems',
          'Some skills need attention'
        )}
      </div>
    )
  }
  if (run.state === 'error') {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AlertTriangle className="size-4 text-destructive" />
          {translate(
            'auto.components.skills.SkillFreshnessUpdateDialog.errorTitle',
            "The update didn't finish"
          )}
        </div>
        <p className="[overflow-wrap:anywhere] font-mono text-[11px] leading-relaxed text-muted-foreground">
          {run.message}
        </p>
      </div>
    )
  }
  return null
}

function skillRowPhase(run: SkillUpdateRun): SkillRowPhase {
  return run.state === 'idle' ? 'plan' : run.state === 'running' ? 'pending' : 'result'
}

function runOutcomes(run: SkillUpdateRun): ReadonlyMap<string, BundledSkillOutcomeSummary> {
  return new Map(
    run.state === 'done' ? run.summary.skills.map((outcome) => [outcome.name, outcome]) : []
  )
}

/**
 * Why: settling a run re-plans every skills surface, and the plan is null while that re-reads
 * the disk. Holding the last plan keeps the rows on screen as the result appears; only the live
 * plan can authorize Update.
 */
function useHeldSkillPlan(
  plan: BundledSkillPlan | null,
  targetKey: string | null
): [BundledSkillPlan | null, () => void] {
  const [held, setHeld] = useState<{ plan: BundledSkillPlan; targetKey: string | null } | null>(
    null
  )
  if (plan && (plan !== held?.plan || targetKey !== held.targetKey)) {
    setHeld({ plan, targetKey })
  }
  // Why the key: another host's rows must never stand in for this one's.
  const heldPlan = held?.targetKey === targetKey ? held.plan : null
  return [plan ?? heldPlan, () => setHeld(null)]
}

/** A run's progress or result once Update starts; until then the plan's headline or error. */
function DialogHeadline({
  run,
  unsupported,
  error,
  plan
}: {
  run: SkillUpdateRun
  unsupported: BundledSkillUnsupportedReason | null
  error: string | null
  plan: BundledSkillPlan | null
}): React.JSX.Element | null {
  if (run.state !== 'idle') {
    return <RunHeadline run={run} />
  }
  if (unsupported) {
    return (
      <p className="text-xs text-muted-foreground">
        {unsupported === 'connect-host'
          ? translate(
              'auto.components.skills.SkillFreshnessUpdateDialog.connectHost',
              'Connect to this SSH host to check its Orca skills.'
            )
          : translate(
              'auto.components.skills.SkillFreshnessUpdateDialog.updateServer',
              'Update Orca on the server to update its Orca skills.'
            )}
      </p>
    )
  }
  return error ? (
    <p className="min-w-0 [overflow-wrap:anywhere] text-xs text-destructive">{error}</p>
  ) : (
    <SummaryHeadline plan={plan} />
  )
}

/** Re-check, Close or Done, and Update; `updatePlan` is null when there is nothing to update. */
function SkillUpdateFooter({
  showResult,
  isRunning,
  checking,
  updatePlan,
  canUpdate,
  onRecheck,
  onClose,
  onUpdate
}: {
  showResult: boolean
  isRunning: boolean
  checking: boolean
  updatePlan: BundledSkillPlan | null
  canUpdate: boolean
  onRecheck: () => void
  onClose: () => void
  onUpdate: () => void
}): React.JSX.Element {
  return (
    <DialogFooter className="sm:justify-between">
      {showResult ? (
        <span />
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isRunning || checking}
          onClick={onRecheck}
        >
          <RefreshCw className={checking ? 'animate-spin' : undefined} />
          {translate('auto.components.skills.SkillFreshnessUpdateDialog.checkNow', 'Re-check')}
        </Button>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={showResult ? 'default' : 'ghost'}
          size="sm"
          onClick={onClose}
        >
          {showResult
            ? translate('auto.components.skills.SkillFreshnessUpdateDialog.done', 'Done')
            : translate('auto.components.skills.SkillFreshnessUpdateDialog.close', 'Close')}
        </Button>
        {!showResult && updatePlan ? (
          <Button type="button" size="sm" disabled={!canUpdate} onClick={onUpdate}>
            {isRunning
              ? translate('auto.components.skills.SkillFreshnessUpdateDialog.updating', 'Updating…')
              : updateActionLabel(updatePlan)}
          </Button>
        ) : null}
      </div>
    </DialogFooter>
  )
}

export function SkillFreshnessUpdateDialog(): React.JSX.Element {
  const target = useActiveProjectSkillRuntime().bundledSkillTarget
  const targetKey = target ? bundledSkillTargetKey(target) : null
  const state = useSkillFreshness(target)
  const run = useSkillUpdateRun(targetKey)
  const open = useSyncExternalStore(
    subscribeSkillFreshnessUpdateDialog,
    getSkillFreshnessUpdateDialogRequest,
    getSkillFreshnessUpdateDialogRequest
  )
  const [force, setForce] = useState<string[]>([])
  // Why: Replace choices name one host's paths, so another host starts without them.
  const [forceTargetKey, setForceTargetKey] = useState(targetKey)
  if (forceTargetKey !== targetKey) {
    setForceTargetKey(targetKey)
    setForce([])
  }
  const reviewed = useReviewedSkillPlan(target, state.plan, force)

  const [shownPlan, releaseHeldPlan] = useHeldSkillPlan(reviewed.plan, targetKey)
  const shownSummary = shownPlan ? summarizeBundledSkillPlan(shownPlan) : null
  const [showLocations, setShowLocations] = useState(false)
  const phase = skillRowPhase(run)
  const isRunning = phase === 'pending'
  const showResult = phase === 'result'
  const livePlan = reviewed.plan
  const canUpdate =
    !isRunning &&
    !showResult &&
    livePlan !== null &&
    !reviewed.loading &&
    summarizeBundledSkillPlan(livePlan).hasWork

  const handleOpenChange = (next: boolean): void => {
    if (next) {
      return
    }
    // Why: closing never cancels; the status-bar segment carries a running update.
    consumeSkillFreshnessUpdateDialogRequest()
    setForce([])
    setShowLocations(false)
    if (run.state === 'idle') {
      releaseHeldPlan()
    }
    if (showResult && targetKey) {
      acknowledgeSkillUpdateRun(targetKey)
    }
    // A settled run on another host would otherwise hold the status bar, which opens this one.
    acknowledgeLatestSkillUpdateRun()
    notifyInstalledAgentSkillsChanged()
  }

  const handleUpdate = (): void => {
    if (!livePlan || !target) {
      return
    }
    void startSkillUpdateRun({
      target,
      // Why: only skills with work; the status bar counts these.
      names: summarizeBundledSkillPlan(livePlan)
        .skills.filter((skill) => skill.state !== 'current')
        .map((skill) => skill.name),
      planDigest: livePlan.planDigest,
      force
    })
  }

  const handleRecheck = (): void => {
    if (targetKey) {
      acknowledgeSkillUpdateRun(targetKey)
    }
    setForce([])
    void state.refresh()
  }

  const replace = {
    isReplaced: (path: string) => force.includes(path),
    onReplaceChange: (path: string, next: boolean) => {
      // Why: a choice made on the result starts a new review of the re-planned skills.
      if (showResult && targetKey) {
        acknowledgeSkillUpdateRun(targetKey)
      }
      setForce((previous) =>
        next ? [...new Set([...previous, path])].sort() : previous.filter((item) => item !== path)
      )
    }
  }

  const error = reviewed.error ?? state.error
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        closeButtonVariant="minimize"
        className="scrollbar-sleek max-h-[85vh] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.skills.SkillFreshnessUpdateDialog.title', 'Update skills')}
          </DialogTitle>
        </DialogHeader>

        <DialogHeadline run={run} unsupported={state.unsupported} error={error} plan={livePlan} />

        {shownSummary && shownSummary.skills.length > 0 ? (
          <SkillUpdateRows
            skills={shownSummary.skills}
            phase={phase}
            outcomes={runOutcomes(run)}
            replace={replace}
            showLocations={showLocations}
            onToggleLocations={() => setShowLocations((previous) => !previous)}
          />
        ) : null}

        <SkillUpdateFooter
          showResult={showResult}
          isRunning={isRunning}
          checking={state.loading}
          updatePlan={shownSummary?.hasWork ? shownPlan : null}
          canUpdate={canUpdate}
          onRecheck={handleRecheck}
          onClose={() => handleOpenChange(false)}
          onUpdate={handleUpdate}
        />
      </DialogContent>
    </Dialog>
  )
}
