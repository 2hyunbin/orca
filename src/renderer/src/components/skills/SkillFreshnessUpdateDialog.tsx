import { useRef, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import type { BundledSkillPlan } from '../../../../shared/bundled-skill-plan'
import { summarizeBundledSkillPlan } from '../../../../shared/bundled-skill-summary'
import { useSkillFreshness } from '@/hooks/useSkillFreshness'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
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
import { TooltipProvider } from '@/components/ui/tooltip'
import { SkillUpdateRow, type SkillRowPhase } from './SkillUpdateRow'
import { SummaryHeadline, updateActionLabel } from './skill-freshness-summary-headline'
import {
  acknowledgeSkillUpdateRun,
  LOCAL_SKILL_UPDATE_TARGET,
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
    return (
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
        {translate('auto.components.skills.SkillFreshnessUpdateDialog.finished', 'Skills updated')}
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

export function SkillFreshnessUpdateDialog(): React.JSX.Element {
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const state = useSkillFreshness(activeSkillRuntime.canUseLocalSkillFreshness)
  const run = useSkillUpdateRun(LOCAL_SKILL_UPDATE_TARGET)
  const open = useSyncExternalStore(
    subscribeSkillFreshnessUpdateDialog,
    getSkillFreshnessUpdateDialogRequest,
    getSkillFreshnessUpdateDialogRequest
  )
  const [force, setForce] = useState<string[]>([])
  const reviewed = useReviewedSkillPlan(state.plan, force)

  // Why: settling a run re-plans every skills surface, and the plan is null while that
  // re-reads the disk. Keeping the last rows on screen avoids blanking the dialog at the
  // moment the result appears; only the live plan can authorize Update.
  const lastPlanRef = useRef<BundledSkillPlan | null>(null)
  if (reviewed.plan) {
    lastPlanRef.current = reviewed.plan
  }
  const shownPlan = reviewed.plan ?? lastPlanRef.current
  const isRunning = run.state === 'running'
  const showResult = run.state === 'done' || run.state === 'error'
  const outcomes = new Map(
    run.state === 'done' ? run.result.skills.map((outcome) => [outcome.name, outcome]) : []
  )
  const phase: SkillRowPhase = isRunning ? 'pending' : showResult ? 'result' : 'plan'
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
    if (run.state === 'idle') {
      lastPlanRef.current = null
    }
    if (showResult) {
      acknowledgeSkillUpdateRun(LOCAL_SKILL_UPDATE_TARGET)
    }
    notifyInstalledAgentSkillsChanged()
  }

  const handleUpdate = (): void => {
    if (!livePlan) {
      return
    }
    void startSkillUpdateRun({
      targetKey: LOCAL_SKILL_UPDATE_TARGET,
      // Why: only skills with work; the status bar counts these.
      names: summarizeBundledSkillPlan(livePlan)
        .skills.filter((skill) => skill.state !== 'current')
        .map((skill) => skill.name),
      planDigest: livePlan.planDigest,
      force
    })
  }

  const handleRecheck = (): void => {
    acknowledgeSkillUpdateRun(LOCAL_SKILL_UPDATE_TARGET)
    setForce([])
    void state.refresh()
  }

  const replace = {
    isReplaced: (path: string) => force.includes(path),
    onReplaceChange: (path: string, next: boolean) =>
      setForce((previous) =>
        next ? [...new Set([...previous, path])].sort() : previous.filter((item) => item !== path)
      )
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

        {error && !isRunning && !showResult ? (
          <p className="min-w-0 [overflow-wrap:anywhere] text-xs text-destructive">{error}</p>
        ) : isRunning || showResult ? (
          <RunHeadline run={run} />
        ) : (
          <SummaryHeadline plan={livePlan} />
        )}

        {shownPlan && shownPlan.skills.length > 0 ? (
          <div className="min-w-0 border-t border-border/60">
            <TooltipProvider>
              {shownPlan.skills.map((entry) => (
                <SkillUpdateRow
                  key={entry.name}
                  entry={entry}
                  phase={phase}
                  outcome={outcomes.get(entry.name)}
                  replace={phase === 'plan' ? replace : undefined}
                />
              ))}
            </TooltipProvider>
          </div>
        ) : null}

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isRunning || state.loading}
            onClick={handleRecheck}
          >
            <RefreshCw className={state.loading ? 'animate-spin' : undefined} />
            {translate('auto.components.skills.SkillFreshnessUpdateDialog.checkNow', 'Re-check')}
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => handleOpenChange(false)}>
              {showResult
                ? translate('auto.components.skills.SkillFreshnessUpdateDialog.done', 'Done')
                : translate('auto.components.skills.SkillFreshnessUpdateDialog.close', 'Close')}
            </Button>
            {!showResult && shownPlan && summarizeBundledSkillPlan(shownPlan).hasWork ? (
              <Button type="button" size="sm" disabled={!canUpdate} onClick={handleUpdate}>
                {isRunning
                  ? translate(
                      'auto.components.skills.SkillFreshnessUpdateDialog.updating',
                      'Updating…'
                    )
                  : updateActionLabel(shownPlan)}
              </Button>
            ) : null}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
